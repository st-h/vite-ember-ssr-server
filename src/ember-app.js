import Module, { builtinModules } from 'node:module';
import { dirname, resolve, normalize } from 'node:path';
import URL from 'node:url';
import vm from 'node:vm';

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
]);
import chalk from 'chalk';
import fs from 'fs-extra';
import { HTMLElement } from 'linkedom/worker';
import sourceMapSupport from 'source-map-support';

import debug from './debug.js';
import createDocument from './document.js';
import Result from './result.js';
import FastBootInfo from './ssr-info.js';
import { loadConfig } from './ssr-schema.js';
import SsrPaths from './utils/ssr-paths.js';

const { statSync, readFile } = fs;
const require = Module.createRequire(import.meta.url);

const noop = function() {};

/**
 * @private
 *
 * The `EmberApp` class serves as a non-sandboxed wrapper around a sandboxed
 * `Ember.Application`. This bridge allows the FastBoot to quickly spin up new
 * `ApplicationInstances` initialized at a particular route, then destroy them
 * once the route has finished rendering.
 */
export default class EmberApp {
  /**
   * Create a new EmberApp.
   * @param {Object} options
   * @param {string} options.distPath - path to the built Ember application
   * @param {Function} [options.buildSandboxGlobals] - the function used to build the final set of global properties accesible within the sandbox
   */
  constructor(options) {
    this.buildSandboxGlobals = options.buildSandboxGlobals || defaultBuildSandboxGlobals;

    this.ssrPaths = SsrPaths.wrap(options.ssrPaths || options);
    let config = loadConfig(this.ssrPaths);

    this.hostWhitelist = config.hostWhitelist;
    this.config = config.config;
    this.appName = config.appName;
    this.html = config.html;
    this.sandboxRequire = config.sandboxRequire;

    if (process.env.APP_CONFIG) {
      let appConfig = JSON.parse(process.env.APP_CONFIG);
      let appConfigKey = this.appName;
      if (!(appConfigKey in appConfig)) {
        this.config[appConfigKey] = appConfig;
      }
    }

    if (process.env.ALL_CONFIG) {
      let allConfig = JSON.parse(process.env.ALL_CONFIG);
      this.config = allConfig;
    }

    this.scripts = config.scripts;

    // Kick off async initialization: build the vm.Context once, compile all
    // modules, create the Ember Application and boot it. All of this happens
    // once and is reused across every request.
    this._ready = this._initSharedApp();
  }

  /**
   * @private
   *
   * Builds and initializes a new sandbox to run the Ember application in.
   */
  buildContext() {
    const { ssrPaths, buildSandboxGlobals, config, appName, sandboxRequire } = this;

    let console = this.buildWrappedConsole();

    function ssrConfig(key) {
      if (!key) {
        // default to app key
        key = appName;
      }

      if (config) {
        return { default: config[key] };
      } else {
        return { default: undefined };
      }
    }

    const Ssr = {
      appConfig: config[appName],
      require: sandboxRequire,
      config: ssrConfig,

      get distPath() {
        return ssrPaths.clientPath;
      },
    };

    const globals = buildSandboxGlobals({
      console,
      setTimeout,
      clearTimeout,
      structuredClone,
      AbortController,
      URL,
      addEventListener: noop,
      removeEventListener: noop,
      document: this.buildSandboxDocument(),
      HTMLElement,
      navigator: { userAgent: '' },

      // Convince jQuery not to assume it's in a browser
      module: { exports: {} },

      sourceMapSupport,
      process,
      Ssr,
      FastBoot: Ssr,
    });

    // Set the global as `window`.
    globals.window = globals;
    globals.window.self = globals;

    return vm.createContext(globals);
  }

  buildSandboxDocument() {
    const doc = createDocument();
    const { config, appName } = this;
    if (config && config[appName]) {
      const meta = doc.createElement('meta');
      meta.setAttribute('name', `${appName}/config/environment`);
      meta.setAttribute('content', encodeURIComponent(JSON.stringify(config[appName])));
      doc.head.appendChild(meta);
    }
    return doc;
  }

  buildWrappedConsole() {
    let wrappedConsole = Object.create(console);

    wrappedConsole.error = function(...args) {
      console.error.apply(
        console,
        args.map(function(a) {
          return typeof a === 'string' ? chalk.red(a) : a;
        })
      );
    };

    return wrappedConsole;
  }

  /**
   * Perform any cleanup that is needed
   */
  destroy() {
    if (this._sharedApp) {
      this._sharedApp.destroy();
      this._sharedApp = null;
    }
    this._sharedContext = null;
  }

  /**
   * @private
   *
   * One-time initialization: build the vm.Context, compile all modules,
   * create the Ember Application and boot it. The Application is reused
   * across all requests — only ApplicationInstances are created per request.
   * This avoids both the vm.SourceTextModule leak (context created once) and
   * the per-request Application overhead (hundreds of factory registrations).
   */
  async _initSharedApp() {
    const context = this.buildContext();

    debug('adding files to sandbox');

    let createSsrApp;
    for (let script of this.scripts) {
      if (!script) {
        continue;
      }
      debug('evaluating file %s', script);
      const { link, importModuleDynamically } = this.buildLink(context, script);
      const module = await this.buildScript(
        script, context, link, importModuleDynamically,
      );
      try {
        await module.evaluate();
        createSsrApp ??= module.namespace?.createSsrApp;
        await Promise.resolve(); // Run microtasks?
      } catch (e) {
        console.log('ssr exception', e);
        return;
      }
    }

    debug('files evaluated');

    if (!createSsrApp || typeof createSsrApp !== 'function') {
      console.log(
        'Failed to load Ember app from app.js, make sure it was built for FastBoot with the `ember fastboot:build` command.'
      );
      return;
    }

    // Remove the config meta from the initial document (used during module eval)
    const configMeta = context.document.querySelector(`meta[name="${this.appName}/config/environment"]`);
    if (configMeta) configMeta.remove();

    debug('creating and booting application');

    const app = createSsrApp();
    await app.boot();

    this._sharedContext = context;
    this._sharedApp = app;
  }

  async buildScript(filePath, context, link, importModuleDynamically, source = null) {
    source ??= await readFile(filePath, { encoding: 'utf8' });
    const module = new vm.SourceTextModule(source, {
      context,
      identifier: filePath,
      importModuleDynamically,
    });
    await module.link(link);
    return module;
  }

  buildLink(context, defaultBase) {
    const importModuleDynamically = async specifier => {
      return (await link(specifier)).namespace;
    };
    const moduleCache = new Map();
    const link = async (specifier, referencingModule) => {
      if (nodeBuiltins.has(specifier)) {
        if (moduleCache.has(specifier)) return moduleCache.get(specifier);
        const canonical = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
        const native = await import(canonical);
        const exportNames = Object.keys(native);
        const synth = new vm.SyntheticModule(
          ['default', ...exportNames.filter(k => k !== 'default')],
          function () {
            this.setExport('default', native.default ?? native);
            for (const key of exportNames) {
              if (key !== 'default') this.setExport(key, native[key]);
            }
          },
          { context, identifier: canonical },
        );
        await synth.link(() => {});
        await synth.evaluate();
        moduleCache.set(specifier, synth);
        return synth;
      }
      const base = referencingModule?.identifier || defaultBase;
      const identifier = await this.resolveImport(specifier, base);
      // Cache compiled modules by resolved path. Without this, every
      // dynamic import during SSR compiles a new SourceTextModule,
      // which are never freed and accumulate until OOM.
      if (moduleCache.has(identifier)) return moduleCache.get(identifier);
      const module = await this.buildScript(
        identifier, context, link, importModuleDynamically,
      );
      await module.evaluate();
      moduleCache.set(identifier, module);
      return module;
    };
    return { link, importModuleDynamically };
  }

  async resolveImport(specifier, importerPath) {
    if (!specifier.startsWith('.')) {
      return require.resolve(specifier);
    }
    const resolvedPath = normalize(resolve(dirname(importerPath), specifier));
    let foundPath;
    const attempts = [
      { },
      { file: 'index.js' },
      { ext: '.mjs' },
      { ext: '.js' }
    ];
    for (const attempt of attempts) {
      let attemptPath = resolvedPath;
      if (attempt.file) {
        attemptPath = resolve(attemptPath, attempt.file);
      }
      if (attempt.ext) {
        attemptPath += attempt.ext;
      }
      const stats = statSync(attemptPath, { throwIfNoEntry: false });
      if (stats?.isFile()) {
        foundPath = attemptPath;
        break;
      }
    }
    return foundPath || require.resolve(specifier);
  }

  /**
   * @private
   *
   * Main function that creates an ApplicationInstance for every `visit` request,
   * boots it and then visits the given route. Only the instance is destroyed
   * after rendering — the Application stays alive across requests.
   *
   * @param {string} path the URL path to render, like `/photos/1`
   * @param {Object} fastbootInfo An object holding per request info
   * @param {Object} bootOptions An object containing the boot options that are used
   *                             by ember to decide whether it needs to do rendering or not.
   * @param {Object} result
   * @return {Promise<instance>} instance
   */
  async _visit(path, fastbootInfo, bootOptions, result) {
    let instance = await this._sharedApp.buildInstance();
    result.applicationInstanceInstance = instance;

    registerFastBootInfo(fastbootInfo, instance);

    await instance.boot(bootOptions);
    await instance.visit(path, bootOptions);
    await fastbootInfo.deferredPromise;
  }

  /**
   * Creates a new application instance and renders the instance at a specific
   * URL, returning a promise that resolves to a {@link Result}. The `Result`
   * gives you access to the rendered HTML as well as metadata about the
   * request such as the HTTP status code.
   *
   * If this call to `visit()` is to service an incoming HTTP request, you may
   * provide Node's `ClientRequest` and `ServerResponse` objects as options
   * (e.g., the `res` and `req` arguments passed to Express middleware).  These
   * are provided to the Ember application via the FastBoot service.
   *
   * @param {string} path the URL path to render, like `/photos/1`
   * @param {Object} options
   * @param {string} [options.html] the HTML document to insert the rendered app into
   * @param {Object} [options.metadata] Per request specific data used in the app.
   * @param {Boolean} [options.shouldRender] whether the app should do rendering or not. If set to false, it puts the app in routing-only.
   * @param {Boolean} [options.disableShoebox] whether we should send the API data in the shoebox. If set to false, it will not send the API data used for rendering the app on server side in the index.html.
   * @param {Integer} [options.destroyAppInstanceInMs] whether to destroy the instance in the given number of ms. This is a failure mechanism to not wedge the Node process (See: https://github.com/ember-fastboot/fastboot/issues/90)
   * @param {ClientRequest}
   * @param {ClientResponse}
   * @returns {Promise<Result>} result
   */
  async visit(path, options) {
    // Wait for the shared Application to be ready
    await this._ready;

    if (!this._sharedApp) {
      throw new Error('SSR application failed to initialize');
    }

    const req = options.request;
    const res = options.response;
    const html = options.html || this.html;
    const disableShoebox = options.disableShoebox || false;
    const destroyAppInstanceInMs = parseInt(options.destroyAppInstanceInMs, 10);

    // Fresh document per request
    const doc = this.buildSandboxDocument();
    this._sharedContext.document = doc;

    const configMeta = doc.querySelector(`meta[name="${this.appName}/config/environment"]`);
    if (configMeta) configMeta.remove();

    const fastbootInfo = new FastBootInfo(req, res, {
      hostWhitelist: this.hostWhitelist,
      metadata: options.metadata || {},
    });

    const result = new Result(doc, html, fastbootInfo);

    // The Application is NOT destroyed per request — only the instance is.
    // Store a reference so Result._destroy() can clean up the instance.
    result.applicationInstance = null;

    const shouldRender = options.shouldRender !== undefined ? options.shouldRender : true;
    const bootOptions = buildBootOptions(shouldRender, doc);

    let destroyAppInstanceTimer;
    if (destroyAppInstanceInMs > 0) {
      destroyAppInstanceTimer = setTimeout(function() {
        if (result.applicationInstanceInstance && !result.isDestroyed) {
          result.applicationInstanceInstance.destroy();
          result.isDestroyed = true;
          result.error = new Error(
            'App instance was forcefully destroyed in ' + destroyAppInstanceInMs + 'ms'
          );
        }
      }, destroyAppInstanceInMs);
    }

    try {
      await this._visit(path, fastbootInfo, bootOptions, result);

      if (!disableShoebox) {
        createShoebox(doc, fastbootInfo);
      }
    } catch (error) {
      // eslint-disable-next-line require-atomic-updates
      result.error = error;
    } finally {
      result._finalize();

      // Only destroy the ApplicationInstance, not the Application
      if (result.applicationInstanceInstance) {
        result.applicationInstanceInstance.destroy();
      }
      result.isDestroyed = true;

      clearTimeout(destroyAppInstanceTimer);
    }

    return result;
  }
}

/*
 * Builds an object with the options required to boot an ApplicationInstance in
 * FastBoot mode.
 */
function buildBootOptions(shouldRender, document) {
  let rootElement = document.body;
  let _renderMode = process.env.EXPERIMENTAL_RENDER_MODE_SERIALIZE ? 'serialize' : undefined;

  return {
    isBrowser: false,
    document,
    rootElement,
    shouldRender,
    _renderMode,
  };
}

/*
 * Writes the shoebox into the DOM for the browser rendered app to consume.
 * Uses a script tag with custom type so that the browser will treat as plain
 * text, and not expend effort trying to parse contents of the script tag.
 * Each key is written separately so that the browser rendered app can
 * parse the specific item at the time it is needed instead of everything
 * all at once.
 */
const hasOwnProperty = Object.prototype.hasOwnProperty; // jshint ignore:line

function createShoebox(doc, fastbootInfo) {
  let shoebox = fastbootInfo.shoebox;
  if (!shoebox) {
    return;
  }

  for (let key in shoebox) {
    if (!hasOwnProperty.call(shoebox, key)) {
      continue;
    } // TODO: remove this later #144, ember-fastboot/ember-cli-fastboot/pull/417
    let value = shoebox[key];
    let textValue = JSON.stringify(value);
    textValue = escapeJSONString(textValue);

    let scriptText = doc.createRawHTMLSection(textValue);
    let scriptEl = doc.createElement('script');

    scriptEl.setAttribute('type', 'fastboot/shoebox');
    scriptEl.setAttribute('id', `shoebox-${key}`);
    scriptEl.appendChild(scriptText);
    doc.body.appendChild(scriptEl);
  }
}

const JSON_ESCAPE = {
  '&': '\\u0026',
  '>': '\\u003e',
  '<': '\\u003c',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

const JSON_ESCAPE_REGEXP = /[\u2028\u2029&><]/g;

function escapeJSONString(string) {
  return string.replace(JSON_ESCAPE_REGEXP, function(match) {
    return JSON_ESCAPE[match];
  });
}

/*
 * Builds a new FastBootInfo instance with the request and response and injects
 * it into the application instance.
 */
function registerFastBootInfo(info, instance) {
  info.register(instance);
}

function defaultBuildSandboxGlobals(defaultGlobals) {
  return defaultGlobals;
}
