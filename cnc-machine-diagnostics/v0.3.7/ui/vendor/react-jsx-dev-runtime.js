import {
  __commonJS,
  __toESM
} from "./chunk-TRTQSARU.js";

// node_modules/react/cjs/react-jsx-dev-runtime.production.js
var require_react_jsx_dev_runtime_production = __commonJS({
  "node_modules/react/cjs/react-jsx-dev-runtime.production.js"(exports) {
    "use strict";
    var REACT_FRAGMENT_TYPE = /* @__PURE__ */ Symbol.for("react.fragment");
    exports.Fragment = REACT_FRAGMENT_TYPE;
    exports.jsxDEV = void 0;
  }
});

// node_modules/react/jsx-dev-runtime.js
var require_jsx_dev_runtime = __commonJS({
  "node_modules/react/jsx-dev-runtime.js"(exports, module) {
    "use strict";
    if (true) {
      module.exports = require_react_jsx_dev_runtime_production();
    } else {
      module.exports = null;
    }
  }
});

// ui/vendor/.entries/react-jsx-dev-runtime.js
var import_jsx_dev_runtime = __toESM(require_jsx_dev_runtime(), 1);
var import_jsx_dev_runtime2 = __toESM(require_jsx_dev_runtime(), 1);
var export_Fragment = import_jsx_dev_runtime.Fragment;
var export_default = import_jsx_dev_runtime2.default;
var export_jsxDEV = import_jsx_dev_runtime.jsxDEV;
export {
  export_Fragment as Fragment,
  export_default as default,
  export_jsxDEV as jsxDEV
};
/*! Bundled license information:

react/cjs/react-jsx-dev-runtime.production.js:
  (**
   * @license React
   * react-jsx-dev-runtime.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)
*/
