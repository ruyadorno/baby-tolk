'use strict';

if (global && global.babyTolkCompilerModulePath) {
  require('app-module-path').addPath(global.babyTolkCompilerModulePath);
}

var Path = require('path');
var when = require('when');
var node = require('when/node');
var fs = node.liftAll(require('fs'));
var accord = require('accord');
var pathCompleteExtname = require('path-complete-extname');
var crypto = require('crypto');
var minify = require('./minify');

var extensionMap;
var loadedAdapters;
var targetExtension;
var sourceExtension;

// Whitelisted adapters
var adapters = [
  'LiveScript',
  'babel',
  'coco',
  'coffee-script',
  'dogescript',
  'less',
  'markdown',
  'myth',
  'scss',
  'stylus',
  'swig',
  'jade'
];


function load() {
  extensionMap = {};
  loadedAdapters = [];

  Object.keys(accord.all()).map(function (engine) {
    if (adapters.indexOf(engine) === -1) {
      return undefined;
    }

    try {
      return accord.load(engine, global && global.babyTolkCompilerModulePath || null);
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND' && e.message.indexOf('Cannot find module') === -1) {
        console.error(e.message.replace(/^error: ?/i, 'Accord Error: ') + '. Try updating to the latest version');
      }
      // else {
      //   console.error('Missing adapter:', engine);
      // }
    }
  }).filter(function (engine) {
    return engine;
  }).forEach(function (adapter) {
    if (adapter.engineName === 'babel' || adapter.engineName === 'babel-core') {
      // Monkey-patching Babel adapter so that it doesn't try and compile all .js files
      adapter.extensions = ['babel.js'];
    }
    loadedAdapters.push(adapter);
    var extensions = adapter.extensions.map(function (extension) { return '.' + extension; });

    extensions.forEach(function (extension) {
      if (!Array.isArray(extensionMap[extension])) {
        extensionMap[extension] = [];
      }

      extensionMap[extension].push(adapter);
    });
  });

  targetExtension = {};
  sourceExtension = {};

  Object.keys(extensionMap).forEach(function (sourceExt) {
    var adapters = extensionMap[sourceExt];
    var targetExt = '.' + adapters[0].output;

    targetExtension[sourceExt] = targetExt;


    if (!sourceExtension[targetExt]) {
      sourceExtension[targetExt] = [];
    }

    sourceExtension[targetExt].push(sourceExt);
  });
}
load();

var dontCompile = function (pathName) {
  // Baby Tolk wont compile files that begin with an underscore `_`.
  // This is by convention.
  var baseName = Path.basename(pathName);
  return baseName[0] === '_';
};

var createHash = function(data) {
  var shasum = crypto.createHash('sha1');
  shasum.update(data);
  return shasum.digest('hex');
};

var sanitizeOptions = function(options) {
  options = options || {};
  options.sourceMap = options.sourceMap === false ? false : true;
  if (options.sha) {
    options.inputSha = true;
    options.outputSha = true;
  }
  return options;
};

var getAdapter = function(extension) {
  var adapters = extensionMap[extension];
  return adapters && adapters[0];
};

var _getTransformId = function(adapter, options) {
  var transformId = '';
  if (adapter) {
    transformId = adapter.engineName + '@' + adapter.engine.version;
  }
  if (options.sourceMap) { transformId += '::map'; }
  if (options.minify) { transformId += '::minify'; }
  return transformId;
};

var getTransformId = function(pathName, options) {
  options = sanitizeOptions(options);
  var extension = pathCompleteExtname(pathName);
  var adapter = !dontCompile(pathName) && getAdapter(extension);
  return _getTransformId(adapter, options);
};

module.exports = {
  get extensions() {
    return extensionMap;
  },
  get sourceExtensionMap() {
    return sourceExtension;
  },
  get targetExtensionMap() {
    return targetExtension;
  },
  reload: load,
  adapters: loadedAdapters,
  isMinifiable: minify.isMinifiable,
  getTransformId: getTransformId,
  read: function (pathName, options) {
    options = sanitizeOptions(options);

    var extension = pathCompleteExtname(pathName);
    var adapter = !dontCompile(pathName) && getAdapter(extension);

    var sourceFile = fs.readFile(pathName, 'utf8');
    var sourceFileContents = null;

    var continuation = sourceFile.then(function(result) {
      var obj = { result: result };
      sourceFileContents = result;
      // if (options.inputSha) { obj.inputSha = createHash(result); }
      return obj;
    });


    var transformId = _getTransformId(adapter, options);
    if (adapter) {
      var transpilerOptions = Object.assign({}, options, {
        sourcemap: options.sourceMap,
        filename: pathName
      });

      if (adapter.engineName === 'node-sass') {
        transpilerOptions.includePaths = [Path.dirname(pathName)];
      }

      continuation = continuation.then(function(source) {
        return adapter.render(source.result, transpilerOptions)
          .then(function(compiled) {
            compiled.extension = '.' + adapter.output;
            compiled.inputPath = pathName;
            if (options.inputSha) { compiled.inputSha = source.inputSha; }
            return compiled;
          });
      });

    } else {
      continuation = continuation.then(function(source) {
        source.extension = extension;
        source.inputPath = pathName;
        return source;
      });
    }

    continuation = continuation.then(function(compiled) {
      if (options.minify) { compiled = minify(compiled, options); }
      if (options.outputSha) { compiled.outputSha = createHash(compiled.result); }
      compiled.transformId = transformId === '' ? null : transformId;
      if (options.inputSha) {
        var inputSha = [{
          file: pathName,
          sha: createHash(sourceFileContents)
        }];
        if (compiled.sourcemap) {
          inputSha = inputSha.concat(compiled.sourcemap.sources.map(function(path) {
            if (path === pathName) { return null; }
            return fs.readFile(path, 'utf8').then(function(content) {
              return {
                file: path,
                sha: createHash(content)
              };
            });
          }).filter(function(x) { return Boolean(x); }));
        }
        return when.all(inputSha).then(function(inputSha) {
          compiled.inputSha = inputSha;
          return compiled;
        });
      }
      return compiled;
    });

    return continuation;
  }
};
