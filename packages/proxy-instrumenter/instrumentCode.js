var babel = require("babel-core");
var path = require("path");
var fs = require("fs");

var sourceMapRegex = /\/\/#[\W]*sourceMappingURL=.*$/;
function removeSourceMapIfAny(code) {
  // In theory we might be able to use this source map, but right now
  // 1) parsing source maps on the frontend is hard, because FE JS doesn't
  //    natively support parsing UTF-8 base64 which is used for inline source maps
  // 2) It could break things if we don't take it out, so need to do some work
  //    to handle the existing source map properly
  if (sourceMapRegex.test(code)) {
    var sourceMapComment = code.match(/\/\/#[\W]*sourceMappingURL=.*$/)[0];
    code = code.replace(sourceMapComment, "");
  }
  return code;
}

module.exports = function instrumentCode() {
  // var babelPluginPath = path.resolve(analysisDirectory + "/babelPlugin.js");
  var babelPlugin = require("babel-plugin-data-flow").default;

  var compilationFailures = [];
  // var envInitCode = fs
  //   .readFileSync(analysisDirectory + "/init.js", "utf-8")
  //   .toString();

  return function processCode(code, url) {
    return new Promise((resolve, reject) => {
      // Include as part of the file rather than injecting into page
      // because there might be other environemnts being created
      // in iframes or web workers
      try {
        console.time("[COMPILER] Compile " + url);
        code = removeSourceMapIfAny(code);
        code = babel.transform(code, {
          sourceFileName: url + "?dontprocess",
          sourceMapTarget: url + ".map",
          sourceMaps: true,
          plugins: [babelPlugin],
          // prevent code from not being pretty after instrumentation:
          // `[BABEL] Note: The code generator has deoptimised the styling of "unknown" as it exceeds the max of "500KB"`
          compact: false
        });

        var resCode = code.code + `\n//# sourceMappingURL=${url}.map`;
        resolve({
          code: resCode,
          map: code.map
        });
        console.timeEnd("[COMPILER] Compile " + url);
      } catch (err) {
        console.log("FAILED " + url, err);
        reject(err);
        throw err;
      }
    });
  };
};
