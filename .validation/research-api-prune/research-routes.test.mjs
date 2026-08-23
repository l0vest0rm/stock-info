// src/modules/research/api/research-investment-analysis.route.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

// node_modules/hono/dist/compose.js
var compose = (middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else {
        handler = i === middleware.length && next || void 0;
      }
      if (handler) {
        try {
          res = await handler(context, () => dispatch(i + 1));
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err;
            res = await onError(err, context);
            isError = true;
          } else {
            throw err;
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context);
        }
      }
      if (res && (context.finalized === false || isError)) {
        context.res = res;
      }
      return context;
    }
  };
};

// node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = /* @__PURE__ */ Symbol();

// node_modules/hono/dist/utils/body.js
var parseBody = async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const headers = request instanceof HonoRequest ? request.raw.headers : request.headers;
  const contentType = headers.get("Content-Type");
  if (contentType?.startsWith("multipart/form-data") || contentType?.startsWith("application/x-www-form-urlencoded")) {
    return parseFormData(request, { all, dot });
  }
  return {};
};
async function parseFormData(request, options) {
  const formData = await request.formData();
  if (formData) {
    return convertFormDataToBodyData(formData, options);
  }
  return {};
}
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  formData.forEach((value, key) => {
    const shouldParseAllValues = options.all || key.endsWith("[]");
    if (!shouldParseAllValues) {
      form[key] = value;
    } else {
      handleParsingAllValues(form, key, value);
    }
  });
  if (options.dot) {
    Object.entries(form).forEach(([key, value]) => {
      const shouldParseDotValues = key.includes(".");
      if (shouldParseDotValues) {
        handleParsingNestedValues(form, key, value);
        delete form[key];
      }
    });
  }
  return form;
}
var handleParsingAllValues = (form, key, value) => {
  if (form[key] !== void 0) {
    if (Array.isArray(form[key])) {
      ;
      form[key].push(value);
    } else {
      form[key] = [form[key], value];
    }
  } else {
    if (!key.endsWith("[]")) {
      form[key] = value;
    } else {
      form[key] = [value];
    }
  }
};
var handleParsingNestedValues = (form, key, value) => {
  if (/(?:^|\.)__proto__\./.test(key)) {
    return;
  }
  let nestedForm = form;
  const keys = key.split(".");
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) {
      nestedForm[key2] = value;
    } else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
};

// node_modules/hono/dist/utils/url.js
var splitPath = (path) => {
  const paths = path.split("/");
  if (paths[0] === "") {
    paths.shift();
  }
  return paths;
};
var splitRoutingPath = (routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
};
var extractGroupsFromPath = (path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match2, index) => {
    const mark = `@${index}`;
    groups.push([mark, match2]);
    return mark;
  });
  return { groups, path };
};
var replaceGroupMarks = (paths, groups) => {
  for (let i = groups.length - 1; i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1; j >= 0; j--) {
      if (paths[j].includes(mark)) {
        paths[j] = paths[j].replace(mark, groups[i][1]);
        break;
      }
    }
  }
  return paths;
};
var patternCache = {};
var getPattern = (label, next) => {
  if (label === "*") {
    return "*";
  }
  const match2 = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match2) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match2[2]) {
        patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [cacheKey, match2[1], new RegExp(`^${match2[2]}(?=/${next})`)] : [label, match2[1], new RegExp(`^${match2[2]}$`)];
      } else {
        patternCache[cacheKey] = [label, match2[1], true];
      }
    }
    return patternCache[cacheKey];
  }
  return null;
};
var tryDecode = (str, decoder) => {
  try {
    return decoder(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match2) => {
      try {
        return decoder(match2);
      } catch {
        return match2;
      }
    });
  }
};
var tryDecodeURI = (str) => tryDecode(str, decodeURI);
var getPath = (request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      const end = queryIndex === -1 ? hashIndex === -1 ? void 0 : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63 || charCode === 35) {
      break;
    }
  }
  return url.slice(start, i);
};
var getPathNoStrict = (request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
};
var mergePath = (base, sub, ...rest) => {
  if (rest.length) {
    sub = mergePath(sub, ...rest);
  }
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
};
var checkOptionalParameter = (path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) {
    return null;
  }
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) {
      basePath += "/" + segment;
    } else if (/\:/.test(segment)) {
      if (/\?/.test(segment)) {
        if (results.length === 0 && basePath === "") {
          results.push("/");
        } else {
          results.push(basePath);
        }
        const optionalSegment = segment.replace("?", "");
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else {
        basePath += "/" + segment;
      }
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
};
var _decodeURI = (value) => {
  if (!/[%+]/.test(value)) {
    return value;
  }
  if (value.indexOf("+") !== -1) {
    value = value.replace(/\+/g, " ");
  }
  return value.indexOf("%") !== -1 ? tryDecode(value, decodeURIComponent_) : value;
};
var _getQueryParam = (url, key, multiple) => {
  let encoded;
  if (!multiple && key && !/[%+]/.test(key)) {
    let keyIndex2 = url.indexOf("?", 8);
    if (keyIndex2 === -1) {
      return void 0;
    }
    if (!url.startsWith(key, keyIndex2 + 1)) {
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) {
        return "";
      }
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) {
      return void 0;
    }
  }
  const results = {};
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) {
      valueIndex = -1;
    }
    let name = url.slice(
      keyIndex + 1,
      valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex
    );
    if (encoded) {
      name = _decodeURI(name);
    }
    keyIndex = nextKeyIndex;
    if (name === "") {
      continue;
    }
    let value;
    if (valueIndex === -1) {
      value = "";
    } else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
      if (encoded) {
        value = _decodeURI(value);
      }
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = [];
      }
      ;
      results[name].push(value);
    } else {
      results[name] ??= value;
    }
  }
  return key ? results[key] : results;
};
var getQueryParam = _getQueryParam;
var getQueryParams = (url, key) => {
  return _getQueryParam(url, key, true);
};
var decodeURIComponent_ = decodeURIComponent;

// node_modules/hono/dist/request.js
var tryDecodeURIComponent = (str) => tryDecode(str, decodeURIComponent_);
var HonoRequest = class {
  /**
   * `.raw` can get the raw Request object.
   *
   * @see {@link https://hono.dev/docs/api/request#raw}
   *
   * @example
   * ```ts
   * // For Cloudflare Workers
   * app.post('/', async (c) => {
   *   const metadata = c.req.raw.cf?.hostMetadata?
   *   ...
   * })
   * ```
   */
  raw;
  #validatedData;
  // Short name of validatedData
  #matchResult;
  routeIndex = 0;
  /**
   * `.path` can get the pathname of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#path}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const pathname = c.req.path // `/about/me`
   * })
   * ```
   */
  path;
  bodyCache = {};
  constructor(request, path = "/", matchResult = [[]]) {
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
    this.#validatedData = {};
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex][1][key];
    const param = this.#getParamValue(paramKey);
    return param && /\%/.test(param) ? tryDecodeURIComponent(param) : param;
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex][1]);
    for (const key of keys) {
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== void 0) {
        decoded[key] = /\%/.test(value) ? tryDecodeURIComponent(value) : value;
      }
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) {
      return this.raw.headers.get(name) ?? void 0;
    }
    const headerData = {};
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return parseBody(this, options);
  }
  #cachedBody = (key) => {
    const { bodyCache, raw: raw2 } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) {
      return cachedBody;
    }
    const anyCachedKey = Object.keys(bodyCache)[0];
    if (anyCachedKey) {
      return bodyCache[anyCachedKey].then((body) => {
        if (anyCachedKey === "json") {
          body = JSON.stringify(body);
        }
        return new Response(body)[key]();
      });
    }
    return bodyCache[key] = raw2[key]();
  };
  /**
   * `.json()` can parse Request body of type `application/json`
   *
   * @see {@link https://hono.dev/docs/api/request#json}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.json()
   * })
   * ```
   */
  json() {
    return this.#cachedBody("text").then((text6) => JSON.parse(text6));
  }
  /**
   * `.text()` can parse Request body of type `text/plain`
   *
   * @see {@link https://hono.dev/docs/api/request#text}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.text()
   * })
   * ```
   */
  text() {
    return this.#cachedBody("text");
  }
  /**
   * `.arrayBuffer()` parse Request body as an `ArrayBuffer`
   *
   * @see {@link https://hono.dev/docs/api/request#arraybuffer}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.arrayBuffer()
   * })
   * ```
   */
  arrayBuffer() {
    return this.#cachedBody("arrayBuffer");
  }
  /**
   * `.bytes()` parses the request body as a `Uint8Array`.
   *
   * @see {@link https://hono.dev/docs/api/request#bytes}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.bytes()
   * })
   * ```
   */
  bytes() {
    return this.#cachedBody("arrayBuffer").then((buffer) => new Uint8Array(buffer));
  }
  /**
   * Parses the request body as a `Blob`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.blob();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#blob
   */
  blob() {
    return this.#cachedBody("blob");
  }
  /**
   * Parses the request body as `FormData`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.formData();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#formdata
   */
  formData() {
    return this.#cachedBody("formData");
  }
  /**
   * Adds validated data to the request.
   *
   * @param target - The target of the validation.
   * @param data - The validated data to add.
   */
  addValidatedData(target, data) {
    this.#validatedData[target] = data;
  }
  valid(target) {
    return this.#validatedData[target];
  }
  /**
   * `.url()` can get the request url strings.
   *
   * @see {@link https://hono.dev/docs/api/request#url}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const url = c.req.url // `http://localhost:8787/about/me`
   *   ...
   * })
   * ```
   */
  get url() {
    return this.raw.url;
  }
  /**
   * `.method()` can get the method name of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#method}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const method = c.req.method // `GET`
   * })
   * ```
   */
  get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  /**
   * `.matchedRoutes()` can return a matched route in the handler
   *
   * @deprecated
   *
   * Use matchedRoutes helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#matchedroutes}
   *
   * @example
   * ```ts
   * app.use('*', async function logger(c, next) {
   *   await next()
   *   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
   *     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
   *     console.log(
   *       method,
   *       ' ',
   *       path,
   *       ' '.repeat(Math.max(10 - path.length, 0)),
   *       name,
   *       i === c.req.routeIndex ? '<- respond from here' : ''
   *     )
   *   })
   * })
   * ```
   */
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  /**
   * `routePath()` can retrieve the path registered within the handler
   *
   * @deprecated
   *
   * Use routePath helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#routepath}
   *
   * @example
   * ```ts
   * app.get('/posts/:id', (c) => {
   *   return c.json({ path: c.req.routePath })
   * })
   * ```
   */
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
};

// node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase = {
  Stringify: 1,
  BeforeStream: 2,
  Stream: 3
};
var raw = (value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
};
var resolveCallback = async (str, phase, preserveCallbacks, context, buffer) => {
  if (typeof str === "object" && !(str instanceof String)) {
    if (!(str instanceof Promise)) {
      str = str.toString();
    }
    if (str instanceof Promise) {
      str = await str;
    }
  }
  const callbacks = str.callbacks;
  if (!callbacks?.length) {
    return Promise.resolve(str);
  }
  if (buffer) {
    buffer[0] += str;
  } else {
    buffer = [str];
  }
  const resStr = Promise.all(callbacks.map((c) => c({ phase, buffer, context }))).then(
    (res) => Promise.all(
      res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))
    ).then(() => buffer[0])
  );
  if (preserveCallbacks) {
    return raw(await resStr, callbacks);
  } else {
    return resStr;
  }
};

// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = (contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
};
var createResponseInstance = (body, init) => new Response(body, init);
var Context = class {
  #rawRequest;
  #req;
  /**
   * `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
   *
   * @see {@link https://hono.dev/docs/api/context#env}
   *
   * @example
   * ```ts
   * // Environment object for Cloudflare Workers
   * app.get('*', async c => {
   *   const counter = c.env.COUNTER
   * })
   * ```
   */
  env = {};
  #var;
  finalized = false;
  /**
   * `.error` can get the error object from the middleware if the Handler throws an error.
   *
   * @see {@link https://hono.dev/docs/api/context#error}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   await next()
   *   if (c.error) {
   *     // do something...
   *   }
   * })
   * ```
   */
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  /**
   * Creates an instance of the Context class.
   *
   * @param req - The Request object.
   * @param options - Optional configuration options for the context.
   */
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  /**
   * `.req` is the instance of {@link HonoRequest}.
   */
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#event}
   * The FetchEvent associated with the current request.
   *
   * @throws Will throw an error if the context does not have a FetchEvent.
   */
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no FetchEvent");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#executionctx}
   * The ExecutionContext associated with the current request.
   *
   * @throws Will throw an error if the context does not have an ExecutionContext.
   */
  get executionCtx() {
    if (this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no ExecutionContext");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#res}
   * The Response object for the current request.
   */
  get res() {
    return this.#res ||= createResponseInstance(null, {
      headers: this.#preparedHeaders ??= new Headers()
    });
  }
  /**
   * Sets the Response object for the current request.
   *
   * @param _res - The Response object to set.
   */
  set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") {
          continue;
        }
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) {
            _res.headers.append("set-cookie", cookie);
          }
        } else {
          _res.headers.set(k, v);
        }
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  /**
   * `.render()` can create a response within a layout.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   return c.render('Hello!')
   * })
   * ```
   */
  render = (...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  };
  /**
   * Sets the layout for the response.
   *
   * @param layout - The layout to set.
   * @returns The layout function.
   */
  setLayout = (layout) => this.#layout = layout;
  /**
   * Gets the current layout for the response.
   *
   * @returns The current layout function.
   */
  getLayout = () => this.#layout;
  /**
   * `.setRenderer()` can set the layout in the custom middleware.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```tsx
   * app.use('*', async (c, next) => {
   *   c.setRenderer((content) => {
   *     return c.html(
   *       <html>
   *         <body>
   *           <p>{content}</p>
   *         </body>
   *       </html>
   *     )
   *   })
   *   await next()
   * })
   * ```
   */
  setRenderer = (renderer) => {
    this.#renderer = renderer;
  };
  /**
   * `.header()` can set headers.
   *
   * @see {@link https://hono.dev/docs/api/context#header}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  header = (name, value, options) => {
    if (this.finalized) {
      this.#res = createResponseInstance(this.#res.body, this.#res);
    }
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
    if (value === void 0) {
      headers.delete(name);
    } else if (options?.append) {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  };
  status = (status) => {
    this.#status = status;
  };
  /**
   * `.set()` can set the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   c.set('message', 'Hono is hot!!')
   *   await next()
   * })
   * ```
   */
  set = (key, value) => {
    this.#var ??= /* @__PURE__ */ new Map();
    this.#var.set(key, value);
  };
  /**
   * `.get()` can use the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   const message = c.get('message')
   *   return c.text(`The message is "${message}"`)
   * })
   * ```
   */
  get = (key) => {
    return this.#var ? this.#var.get(key) : void 0;
  };
  /**
   * `.var` can access the value of a variable.
   *
   * @see {@link https://hono.dev/docs/api/context#var}
   *
   * @example
   * ```ts
   * const result = c.var.client.oneMethod()
   * ```
   */
  // c.var.propName is a read-only
  get var() {
    if (!this.#var) {
      return {};
    }
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    const responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders ?? new Headers();
    if (typeof arg === "object" && "headers" in arg) {
      const argHeaders = arg.headers instanceof Headers ? arg.headers : new Headers(arg.headers);
      for (const [key, value] of argHeaders) {
        if (key.toLowerCase() === "set-cookie") {
          responseHeaders.append(key, value);
        } else {
          responseHeaders.set(key, value);
        }
      }
    }
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") {
          responseHeaders.set(k, v);
        } else {
          responseHeaders.delete(k);
          for (const v2 of v) {
            responseHeaders.append(k, v2);
          }
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, { status, headers: responseHeaders });
  }
  newResponse = (...args) => this.#newResponse(...args);
  /**
   * `.body()` can return the HTTP response.
   * You can set headers with `.header()` and set HTTP status code with `.status`.
   * This can also be set in `.text()`, `.json()` and so on.
   *
   * @see {@link https://hono.dev/docs/api/context#body}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *   // Set HTTP status code
   *   c.status(201)
   *
   *   // Return the response body
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  body = (data, arg, headers) => this.#newResponse(data, arg, headers);
  /**
   * `.text()` can render text as `Content-Type:text/plain`.
   *
   * @see {@link https://hono.dev/docs/api/context#text}
   *
   * @example
   * ```ts
   * app.get('/say', (c) => {
   *   return c.text('Hello!')
   * })
   * ```
   */
  text = (text6, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text6) : this.#newResponse(
      text6,
      arg,
      setDefaultContentType(TEXT_PLAIN, headers)
    );
  };
  /**
   * `.json()` can render JSON as `Content-Type:application/json`.
   *
   * @see {@link https://hono.dev/docs/api/context#json}
   *
   * @example
   * ```ts
   * app.get('/api', (c) => {
   *   return c.json({ message: 'Hello!' })
   * })
   * ```
   */
  json = (object3, arg, headers) => {
    return this.#newResponse(
      JSON.stringify(object3),
      arg,
      setDefaultContentType("application/json", headers)
    );
  };
  html = (html, arg, headers) => {
    const res = (html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers));
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  };
  /**
   * `.redirect()` can Redirect, default status code is 302.
   *
   * @see {@link https://hono.dev/docs/api/context#redirect}
   *
   * @example
   * ```ts
   * app.get('/redirect', (c) => {
   *   return c.redirect('/')
   * })
   * app.get('/redirect-permanently', (c) => {
   *   return c.redirect('/', 301)
   * })
   * ```
   */
  redirect = (location, status) => {
    const locationString = String(location);
    this.header(
      "Location",
      // Multibyes should be encoded
      // eslint-disable-next-line no-control-regex
      !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString)
    );
    return this.newResponse(null, status ?? 302);
  };
  /**
   * `.notFound()` can return the Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/context#notfound}
   *
   * @example
   * ```ts
   * app.get('/notfound', (c) => {
   *   return c.notFound()
   * })
   * ```
   */
  notFound = () => {
    this.#notFoundHandler ??= () => createResponseInstance();
    return this.#notFoundHandler(this);
  };
};

// node_modules/hono/dist/router.js
var METHOD_NAME_ALL = "ALL";
var METHOD_NAME_ALL_LOWERCASE = "all";
var METHODS = ["get", "post", "put", "delete", "options", "patch"];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = class extends Error {
};

// node_modules/hono/dist/utils/constants.js
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";

// node_modules/hono/dist/hono-base.js
var notFoundHandler = (c) => {
  return c.text("404 Not Found", 404);
};
var errorHandler = (err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
};
var Hono = class _Hono {
  get;
  post;
  put;
  delete;
  options;
  patch;
  all;
  on;
  use;
  /*
    This class is like an abstract class and does not have a router.
    To use it, inherit the class and implement router in the constructor.
  */
  router;
  getPath;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
    allMethods.forEach((method) => {
      this[method] = (args1, ...args) => {
        if (typeof args1 === "string") {
          this.#path = args1;
        } else {
          this.#addRoute(method, this.#path, args1);
        }
        args.forEach((handler) => {
          this.#addRoute(method, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          handlers.map((handler) => {
            this.#addRoute(m.toUpperCase(), this.#path, handler);
          });
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") {
        this.#path = arg1;
      } else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute(METHOD_NAME_ALL, this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new _Hono({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  errorHandler = errorHandler;
  /**
   * `.route()` allows grouping other Hono instance in routes.
   *
   * @see {@link https://hono.dev/docs/api/routing#grouping}
   *
   * @param {string} path - base Path
   * @param {Hono} app - other Hono instance
   * @returns {Hono} routed Hono instance
   *
   * @example
   * ```ts
   * const app = new Hono()
   * const app2 = new Hono()
   *
   * app2.get("/user", (c) => c.text("user"))
   * app.route("/api", app2) // GET /api/user
   * ```
   */
  route(path, app) {
    const subApp = this.basePath(path);
    app.routes.map((r) => {
      let handler;
      if (app.errorHandler === errorHandler) {
        handler = r.handler;
      } else {
        handler = async (c, next) => (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res;
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler, r.basePath);
    });
    return this;
  }
  /**
   * `.basePath()` allows base paths to be specified.
   *
   * @see {@link https://hono.dev/docs/api/routing#base-path}
   *
   * @param {string} path - base Path
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * const api = new Hono().basePath('/api')
   * ```
   */
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  /**
   * `.onError()` handles an error and returns a customized Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#error-handling}
   *
   * @param {ErrorHandler} handler - request Handler for error
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.onError((err, c) => {
   *   console.error(`${err}`)
   *   return c.text('Custom Error Message', 500)
   * })
   * ```
   */
  onError = (handler) => {
    this.errorHandler = handler;
    return this;
  };
  /**
   * `.notFound()` allows you to customize a Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#not-found}
   *
   * @param {NotFoundHandler} handler - request handler for not-found
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.notFound((c) => {
   *   return c.text('Custom 404 Message', 404)
   * })
   * ```
   */
  notFound = (handler) => {
    this.#notFoundHandler = handler;
    return this;
  };
  /**
   * `.mount()` allows you to mount applications built with other frameworks into your Hono application.
   *
   * @see {@link https://hono.dev/docs/api/hono#mount}
   *
   * @param {string} path - base Path
   * @param {Function} applicationHandler - other Request Handler
   * @param {MountOptions} [options] - options of `.mount()`
   * @returns {Hono} mounted Hono instance
   *
   * @example
   * ```ts
   * import { Router as IttyRouter } from 'itty-router'
   * import { Hono } from 'hono'
   * // Create itty-router application
   * const ittyRouter = IttyRouter()
   * // GET /itty-router/hello
   * ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
   *
   * const app = new Hono()
   * app.mount('/itty-router', ittyRouter.handle)
   * ```
   *
   * @example
   * ```ts
   * const app = new Hono()
   * // Send the request to another application without modification.
   * app.mount('/app', anotherApp, {
   *   replaceRequest: (req) => req,
   * })
   * ```
   */
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") {
        optionHandler = options;
      } else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) {
          replaceRequest = (request) => request;
        } else {
          replaceRequest = options.replaceRequest;
        }
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = void 0;
      try {
        executionContext = c.executionCtx;
      } catch {
      }
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request) => {
        const url = new URL(request.url);
        url.pathname = this.getPath(request).slice(pathPrefixLength) || "/";
        return new Request(url, request);
      };
    })();
    const handler = async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) {
        return res;
      }
      await next();
    };
    this.#addRoute(METHOD_NAME_ALL, mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler, baseRoutePath) {
    method = method.toUpperCase();
    path = mergePath(this._basePath, path);
    const r = {
      basePath: baseRoutePath !== void 0 ? mergePath(this._basePath, baseRoutePath) : this._basePath,
      path,
      method,
      handler
    };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) {
      return this.errorHandler(err, c);
    }
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") {
      return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    }
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then(
        (resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))
      ).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) {
          throw new Error(
            "Context is not finalized. Did you forget to return a Response object or `await next()`?"
          );
        }
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  /**
   * `.fetch()` will be entry point of your app.
   *
   * @see {@link https://hono.dev/docs/api/hono#fetch}
   *
   * @param {Request} request - request Object of request
   * @param {Env} Env - env Object
   * @param {ExecutionContext} - context of execution
   * @returns {Response | Promise<Response>} response of request
   *
   */
  fetch = (request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  };
  /**
   * `.request()` is a useful method for testing.
   * You can pass a URL or pathname to send a GET request.
   * app will return a Response object.
   * ```ts
   * test('GET /hello is ok', async () => {
   *   const res = await app.request('/hello')
   *   expect(res.status).toBe(200)
   * })
   * ```
   * @see https://hono.dev/docs/api/hono#request
   */
  request = (input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) {
      return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    }
    input = input.toString();
    return this.fetch(
      new Request(
        /^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`,
        requestInit
      ),
      Env,
      executionCtx
    );
  };
  /**
   * `.fire()` automatically adds a global fetch event listener.
   * This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
   * @deprecated
   * Use `fire` from `hono/service-worker` instead.
   * ```ts
   * import { Hono } from 'hono'
   * import { fire } from 'hono/service-worker'
   *
   * const app = new Hono()
   * // ...
   * fire(app)
   * ```
   * @see https://hono.dev/docs/api/hono#fire
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
   * @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
   */
  fire = () => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.#dispatch(event.request, event, void 0, event.request.method));
    });
  };
};

// node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = ((method2, path2) => {
    const matcher = matchers[method2] || matchers[METHOD_NAME_ALL];
    const staticMatch = matcher[2][path2];
    if (staticMatch) {
      return staticMatch;
    }
    const match3 = path2.match(matcher[0]);
    if (!match3) {
      return [[], emptyParam];
    }
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  });
  this.match = match2;
  return match2(method, path);
}

// node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = ".*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
var PATH_ERROR = /* @__PURE__ */ Symbol();
var regExpMetaChars = new Set(".\\+*[^]$()");
function compareKey(a, b) {
  if (a.length === 1) {
    return b.length === 1 ? a < b ? -1 : 1 : -1;
  }
  if (b.length === 1) {
    return 1;
  }
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return 1;
  } else if (b === ONLY_WILDCARD_REG_EXP_STR || b === TAIL_WILDCARD_REG_EXP_STR) {
    return -1;
  }
  if (a === LABEL_REG_EXP_STR) {
    return 1;
  } else if (b === LABEL_REG_EXP_STR) {
    return -1;
  }
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
var Node = class _Node {
  #index;
  #varIndex;
  #children = /* @__PURE__ */ Object.create(null);
  insert(tokens, index, paramMap, context, pathErrorCheckOnly) {
    if (tokens.length === 0) {
      if (this.#index !== void 0) {
        throw PATH_ERROR;
      }
      if (pathErrorCheckOnly) {
        return;
      }
      this.#index = index;
      return;
    }
    const [token, ...restTokens] = tokens;
    const pattern = token === "*" ? restTokens.length === 0 ? ["", "", ONLY_WILDCARD_REG_EXP_STR] : ["", "", LABEL_REG_EXP_STR] : token === "/*" ? ["", "", TAIL_WILDCARD_REG_EXP_STR] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
    let node;
    if (pattern) {
      const name = pattern[1];
      let regexpStr = pattern[2] || LABEL_REG_EXP_STR;
      if (name && pattern[2]) {
        if (regexpStr === ".*") {
          throw PATH_ERROR;
        }
        regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
        if (/\((?!\?:)/.test(regexpStr)) {
          throw PATH_ERROR;
        }
      }
      node = this.#children[regexpStr];
      if (!node) {
        if (Object.keys(this.#children).some(
          (k) => k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
        )) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[regexpStr] = new _Node();
        if (name !== "") {
          node.#varIndex = context.varIndex++;
        }
      }
      if (!pathErrorCheckOnly && name !== "") {
        paramMap.push([name, node.#varIndex]);
      }
    } else {
      node = this.#children[token];
      if (!node) {
        if (Object.keys(this.#children).some(
          (k) => k.length > 1 && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
        )) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[token] = new _Node();
      }
    }
    node.insert(restTokens, index, paramMap, context, pathErrorCheckOnly);
  }
  buildRegExpStr() {
    const childKeys = Object.keys(this.#children).sort(compareKey);
    const strList = childKeys.map((k) => {
      const c = this.#children[k];
      return (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + c.buildRegExpStr();
    });
    if (typeof this.#index === "number") {
      strList.unshift(`#${this.#index}`);
    }
    if (strList.length === 0) {
      return "";
    }
    if (strList.length === 1) {
      return strList[0];
    }
    return "(?:" + strList.join("|") + ")";
  }
};

// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
  #context = { varIndex: 0 };
  #root = new Node();
  insert(path, index, pathErrorCheckOnly) {
    const paramAssoc = [];
    const groups = [];
    for (let i = 0; ; ) {
      let replaced = false;
      path = path.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) {
        break;
      }
    }
    const tokens = path.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1; j >= 0; j--) {
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1]);
          break;
        }
      }
    }
    this.#root.insert(tokens, index, paramAssoc, this.#context, pathErrorCheckOnly);
    return paramAssoc;
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") {
      return [/^$/, [], []];
    }
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== void 0) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== void 0) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap];
  }
};

// node_modules/hono/dist/router/reg-exp-router/router.js
var nullMatcher = [/^$/, [], /* @__PURE__ */ Object.create(null)];
var wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
function buildWildcardRegExp(path) {
  return wildcardRegExpCache[path] ??= new RegExp(
    path === "*" ? "" : `^${path.replace(
      /\/\*$|([.\\+*[^\]$()])/g,
      (_, metaChar) => metaChar ? `\\${metaChar}` : "(?:|/.*)"
    )}$`
  );
}
function clearWildcardRegExpCache() {
  wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
}
function buildMatcherFromPreprocessedRoutes(routes) {
  const trie = new Trie();
  const handlerData = [];
  if (routes.length === 0) {
    return nullMatcher;
  }
  const routesWithStaticPathFlag = routes.map(
    (route) => [!/\*|\/:/.test(route[0]), ...route]
  ).sort(
    ([isStaticA, pathA], [isStaticB, pathB]) => isStaticA ? 1 : isStaticB ? -1 : pathA.length - pathB.length
  );
  const staticMap = /* @__PURE__ */ Object.create(null);
  for (let i = 0, j = -1, len = routesWithStaticPathFlag.length; i < len; i++) {
    const [pathErrorCheckOnly, path, handlers] = routesWithStaticPathFlag[i];
    if (pathErrorCheckOnly) {
      staticMap[path] = [handlers.map(([h]) => [h, /* @__PURE__ */ Object.create(null)]), emptyParam];
    } else {
      j++;
    }
    let paramAssoc;
    try {
      paramAssoc = trie.insert(path, j, pathErrorCheckOnly);
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
    if (pathErrorCheckOnly) {
      continue;
    }
    handlerData[j] = handlers.map(([h, paramCount]) => {
      const paramIndexMap = /* @__PURE__ */ Object.create(null);
      paramCount -= 1;
      for (; paramCount >= 0; paramCount--) {
        const [key, value] = paramAssoc[paramCount];
        paramIndexMap[key] = value;
      }
      return [h, paramIndexMap];
    });
  }
  const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
  for (let i = 0, len = handlerData.length; i < len; i++) {
    for (let j = 0, len2 = handlerData[i].length; j < len2; j++) {
      const map = handlerData[i][j]?.[1];
      if (!map) {
        continue;
      }
      const keys = Object.keys(map);
      for (let k = 0, len3 = keys.length; k < len3; k++) {
        map[keys[k]] = paramReplacementMap[map[keys[k]]];
      }
    }
  }
  const handlerMap = [];
  for (const i in indexReplacementMap) {
    handlerMap[i] = handlerData[indexReplacementMap[i]];
  }
  return [regexp, handlerMap, staticMap];
}
function findMiddleware(middleware, path) {
  if (!middleware) {
    return void 0;
  }
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) {
    if (buildWildcardRegExp(k).test(path)) {
      return [...middleware[k]];
    }
  }
  return void 0;
}
var RegExpRouter = class {
  name = "RegExpRouter";
  #middleware;
  #routes;
  constructor() {
    this.#middleware = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
    this.#routes = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
  }
  add(method, path, handler) {
    const middleware = this.#middleware;
    const routes = this.#routes;
    if (!middleware || !routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    if (!middleware[method]) {
      ;
      [middleware, routes].forEach((handlerMap) => {
        handlerMap[method] = /* @__PURE__ */ Object.create(null);
        Object.keys(handlerMap[METHOD_NAME_ALL]).forEach((p) => {
          handlerMap[method][p] = [...handlerMap[METHOD_NAME_ALL][p]];
        });
      });
    }
    if (path === "/*") {
      path = "*";
    }
    const paramCount = (path.match(/\/:/g) || []).length;
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      if (method === METHOD_NAME_ALL) {
        Object.keys(middleware).forEach((m) => {
          middleware[m][path] ||= findMiddleware(middleware[m], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
        });
      } else {
        middleware[method][path] ||= findMiddleware(middleware[method], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
      }
      Object.keys(middleware).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(middleware[m]).forEach((p) => {
            re.test(p) && middleware[m][p].push([handler, paramCount]);
          });
        }
      });
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(routes[m]).forEach(
            (p) => re.test(p) && routes[m][p].push([handler, paramCount])
          );
        }
      });
      return;
    }
    const paths = checkOptionalParameter(path) || [path];
    for (let i = 0, len = paths.length; i < len; i++) {
      const path2 = paths[i];
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          routes[m][path2] ||= [
            ...findMiddleware(middleware[m], path2) || findMiddleware(middleware[METHOD_NAME_ALL], path2) || []
          ];
          routes[m][path2].push([handler, paramCount - len + i + 1]);
        }
      });
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = /* @__PURE__ */ Object.create(null);
    Object.keys(this.#routes).concat(Object.keys(this.#middleware)).forEach((method) => {
      matchers[method] ||= this.#buildMatcher(method);
    });
    this.#middleware = this.#routes = void 0;
    clearWildcardRegExpCache();
    return matchers;
  }
  #buildMatcher(method) {
    const routes = [];
    let hasOwnRoute = method === METHOD_NAME_ALL;
    [this.#middleware, this.#routes].forEach((r) => {
      const ownRoute = r[method] ? Object.keys(r[method]).map((path) => [path, r[method][path]]) : [];
      if (ownRoute.length !== 0) {
        hasOwnRoute ||= true;
        routes.push(...ownRoute);
      } else if (method !== METHOD_NAME_ALL) {
        routes.push(
          ...Object.keys(r[METHOD_NAME_ALL]).map((path) => [path, r[METHOD_NAME_ALL][path]])
        );
      }
    });
    if (!hasOwnRoute) {
      return null;
    } else {
      return buildMatcherFromPreprocessedRoutes(routes);
    }
  }
};

// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    this.#routes.push([method, path, handler]);
  }
  match(method, path) {
    if (!this.#routes) {
      throw new Error("Fatal error");
    }
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (; i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length; i2 < len2; i2++) {
          router.add(...routes[i2]);
        }
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) {
          continue;
        }
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = void 0;
      break;
    }
    if (i === len) {
      throw new Error("Fatal error");
    }
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) {
      throw new Error("No active router has been determined yet.");
    }
    return this.#routers[0];
  }
};

// node_modules/hono/dist/router/trie-router/node.js
var emptyParams = /* @__PURE__ */ Object.create(null);
var hasChildren = (children) => {
  for (const _ in children) {
    return true;
  }
  return false;
};
var Node2 = class _Node2 {
  #methods;
  #children;
  #patterns;
  #order = 0;
  #params = emptyParams;
  constructor(method, handler, children) {
    this.#children = children || /* @__PURE__ */ Object.create(null);
    this.#methods = [];
    if (method && handler) {
      const m = /* @__PURE__ */ Object.create(null);
      m[method] = { handler, possibleKeys: [], score: 0 };
      this.#methods = [m];
    }
    this.#patterns = [];
  }
  insert(method, path, handler) {
    this.#order = ++this.#order;
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = [];
    for (let i = 0, len = parts.length; i < len; i++) {
      const p = parts[i];
      const nextP = parts[i + 1];
      const pattern = getPattern(p, nextP);
      const key = Array.isArray(pattern) ? pattern[0] : p;
      if (key in curNode.#children) {
        curNode = curNode.#children[key];
        if (pattern) {
          possibleKeys.push(pattern[1]);
        }
        continue;
      }
      curNode.#children[key] = new _Node2();
      if (pattern) {
        curNode.#patterns.push(pattern);
        possibleKeys.push(pattern[1]);
      }
      curNode = curNode.#children[key];
    }
    curNode.#methods.push({
      [method]: {
        handler,
        possibleKeys: possibleKeys.filter((v, i, a) => a.indexOf(v) === i),
        score: this.#order
      }
    });
    return curNode;
  }
  #pushHandlerSets(handlerSets, node, method, nodeParams, params) {
    for (let i = 0, len = node.#methods.length; i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m[METHOD_NAME_ALL];
      const processedSet = {};
      if (handlerSet !== void 0) {
        handlerSet.params = /* @__PURE__ */ Object.create(null);
        handlerSets.push(handlerSet);
        if (nodeParams !== emptyParams || params && params !== emptyParams) {
          for (let i2 = 0, len2 = handlerSet.possibleKeys.length; i2 < len2; i2++) {
            const key = handlerSet.possibleKeys[i2];
            const processed = processedSet[handlerSet.score];
            handlerSet.params[key] = params?.[key] && !processed ? params[key] : nodeParams[key] ?? params?.[key];
            processedSet[handlerSet.score] = true;
          }
        }
      }
    }
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    const curNode = this;
    let curNodes = [curNode];
    const parts = splitPath(path);
    const curNodesQueue = [];
    const len = parts.length;
    let partOffsets = null;
    for (let i = 0; i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length; j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) {
              this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
            }
            this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
          } else {
            tempNodes.push(nextNode);
          }
        }
        for (let k = 0, len3 = node.#patterns.length; k < len3; k++) {
          const pattern = node.#patterns[k];
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (pattern === "*") {
            const astNode = node.#children["*"];
            if (astNode) {
              this.#pushHandlerSets(handlerSets, astNode, method, node.#params);
              astNode.#params = params;
              tempNodes.push(astNode);
            }
            continue;
          }
          const [key, name, matcher] = pattern;
          if (!part && !(matcher instanceof RegExp)) {
            continue;
          }
          const child = node.#children[key];
          if (matcher instanceof RegExp) {
            if (partOffsets === null) {
              partOffsets = new Array(len);
              let offset = path[0] === "/" ? 1 : 0;
              for (let p = 0; p < len; p++) {
                partOffsets[p] = offset;
                offset += parts[p].length + 1;
              }
            }
            const restPathString = path.substring(partOffsets[i]);
            const m = matcher.exec(restPathString);
            if (m) {
              params[name] = m[0];
              this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
              if (hasChildren(child.#children)) {
                child.#params = params;
                const componentCount = m[0].match(/\//)?.length ?? 0;
                const targetCurNodes = curNodesQueue[componentCount] ||= [];
                targetCurNodes.push(child);
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            params[name] = part;
            if (isLast) {
              this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
              if (child.#children["*"]) {
                this.#pushHandlerSets(
                  handlerSets,
                  child.#children["*"],
                  method,
                  params,
                  node.#params
                );
              }
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      const shifted = curNodesQueue.shift();
      curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
    }
    if (handlerSets.length > 1) {
      handlerSets.sort((a, b) => {
        return a.score - b.score;
      });
    }
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
};

// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
  name = "TrieRouter";
  #node;
  constructor() {
    this.#node = new Node2();
  }
  add(method, path, handler) {
    const results = checkOptionalParameter(path);
    if (results) {
      for (let i = 0, len = results.length; i < len; i++) {
        this.#node.insert(method, results[i], handler);
      }
      return;
    }
    this.#node.insert(method, path, handler);
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
};

// node_modules/hono/dist/hono.js
var Hono2 = class extends Hono {
  /**
   * Creates an instance of the Hono class.
   *
   * @param options - Optional configuration options for the Hono instance.
   */
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({
      routers: [new RegExpRouter(), new TrieRouter()]
    });
  }
};

// src/shared/codes.ts
function normalizeSecurityCode(input) {
  const raw2 = input.trim().toUpperCase();
  if (!raw2) {
    return "";
  }
  const compactKorea = raw2.match(/^(\d{6})(KS|KQ)$/);
  if (compactKorea) {
    return `${compactKorea[1]}.${compactKorea[2]}`;
  }
  const malformedKorea = raw2.match(/^(\d{6})(KS|KQ)\.(SH|SZ)$/);
  if (malformedKorea) {
    return `${malformedKorea[1]}.${malformedKorea[2]}`;
  }
  if (raw2.includes(".")) {
    return raw2;
  }
  if (/^\d{6}$/.test(raw2)) {
    if (raw2.startsWith("5") || raw2.startsWith("6") || raw2.startsWith("9")) {
      return `${raw2}.SH`;
    }
    if (raw2.startsWith("0") || raw2.startsWith("1") || raw2.startsWith("2") || raw2.startsWith("3")) {
      return `${raw2}.SZ`;
    }
  }
  if (/^\d{5}$/.test(raw2)) {
    return `${raw2}.HK`;
  }
  return raw2;
}
function isSupportedCompanyCode(input) {
  const normalized = normalizeSecurityCode(input);
  return /^\d{6}\.(SH|SZ|BJ)$/.test(normalized) || /^\d{5}\.HK$/.test(normalized) || /^[A-Z0-9.-]+\.US$/.test(normalized);
}
function isSupportedSecurityCode(input) {
  const normalized = normalizeSecurityCode(input);
  return isSupportedCompanyCode(normalized) || /^\d{6}\.(OF|SF|ZF|KS|KQ)$/.test(normalized) || normalized === "KS11.UI" || normalized === "HSI.HK";
}
function securityMarket(code) {
  const normalized = normalizeSecurityCode(code);
  const suffix = normalized.split(".").pop() ?? "";
  switch (suffix) {
    case "SH":
      return "cn-sh";
    case "SZ":
      return "cn-sz";
    case "BJ":
      return "cn-bj";
    case "HK":
      return "hk";
    case "US":
      return "us";
    case "OF":
      return "fund";
    case "UI":
      return normalized === "KS11.UI" ? "kr" : "global";
    default:
      return "global";
  }
}
function inferSecurityType(code) {
  const normalized = normalizeSecurityCode(code);
  if (normalized.endsWith(".OF") || normalized.endsWith(".SF") || normalized.endsWith(".ZF")) {
    return "fund";
  }
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(normalized)) {
    const base = normalized.slice(0, 6);
    if (base.startsWith("5") || base.startsWith("1")) {
      return "fund";
    }
    return "stock";
  }
  return "stock";
}
function bareCode(code) {
  return normalizeSecurityCode(code).split(".")[0] ?? "";
}
function securitySuffix(code) {
  return normalizeSecurityCode(code).split(".")[1] ?? "";
}

// src/db/queries.ts
async function getHttpCache(db, cacheKey, now = Date.now()) {
  const row = await db.prepare(
    `select status, headers_json as headersJson, body_text as bodyText,
        expires_at as expiresAt, updated_at as updatedAt
       from http_cache
       where cache_key = ? and expires_at > ?`
  ).bind(cacheKey, now).first();
  return row ?? null;
}
async function putHttpCache(db, record3) {
  await db.prepare(
    `insert into http_cache
        (cache_key, url, method, status, headers_json, body_text, expires_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(cache_key) do update set
        url = excluded.url,
        method = excluded.method,
        status = excluded.status,
        headers_json = excluded.headers_json,
        body_text = excluded.body_text,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`
  ).bind(
    record3.cacheKey,
    record3.url,
    record3.method,
    record3.status,
    record3.headersJson,
    record3.bodyText,
    record3.expiresAt,
    record3.updatedAt
  ).run();
}
async function getKvCache(db, namespace, key, now = Date.now()) {
  const row = await db.prepare(
    `select namespace, key, value_json as valueJson, expires_at as expiresAt, updated_at as updatedAt
       from kv_cache
       where namespace = ? and key = ? and (expires_at is null or expires_at > ?)`
  ).bind(namespace, key, now).first();
  return row ?? null;
}
async function putKvCache(db, record3) {
  await db.prepare(
    `insert into kv_cache (namespace, key, value_json, expires_at, updated_at)
       values (?, ?, ?, ?, ?)
       on conflict(namespace, key) do update set
        value_json = excluded.value_json,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`
  ).bind(record3.namespace, record3.key, record3.valueJson, record3.expiresAt, record3.updatedAt).run();
}

// src/shared/http.ts
var DEFAULT_EXTERNAL_HTTP_TIMEOUT_MS = 1e4;
var DEFAULT_DOMAIN_CONCURRENCY = 3;
var domainLimiters = /* @__PURE__ */ new Map();
var ExternalRequestTimeoutError = class extends Error {
  status = 504;
  constructor(host, timeoutMs, options) {
    super(`external request timed out: host=${host} timeoutMs=${timeoutMs}`, options);
    this.name = "ExternalRequestTimeoutError";
  }
};
var ExternalConcurrencyTimeoutError = class extends Error {
  status = 504;
  constructor(host, limit, timeoutMs) {
    super(`external request concurrency wait timed out: host=${host} limit=${limit} timeoutMs=${timeoutMs}`);
    this.name = "ExternalConcurrencyTimeoutError";
  }
};
function ok(c, data) {
  const body = { code: 200, msg: "OK", data };
  return c.json(body);
}
function fail(c, status, message2) {
  const body = { code: status, msg: message2, data: null };
  return c.json(body, status);
}
async function cachedFetchJson(db, url, init, ttlMs = 60 * 60 * 1e3, options) {
  const text6 = await cachedFetchText(db, url, init, ttlMs, options);
  return parseJsonOrJsonp(text6);
}
async function cachedFetchText(db, url, init, ttlMs = 60 * 60 * 1e3, options) {
  const request = normalizeRequest(url, init);
  const cacheKey = options?.cacheKey || await digestHex(JSON.stringify(request));
  const cacheTtlMs = options?.cacheTtlMs ?? ttlMs;
  const cached = await getHttpCache(db, cacheKey);
  if (cached) {
    return cached.bodyText;
  }
  const { status, headers, text: text6 } = await fetchTextResponse(url, init, options);
  const now = Date.now();
  const resolvedTtlMs = options?.resolveCacheTtlMs?.({ status, headers, text: text6 });
  const finalCacheTtlMs = Number.isFinite(resolvedTtlMs) && resolvedTtlMs && resolvedTtlMs > 0 ? resolvedTtlMs : cacheTtlMs;
  if (!options?.cacheMaxBytes || new TextEncoder().encode(text6).byteLength <= options.cacheMaxBytes) {
    await putHttpCache(db, {
      cacheKey,
      url,
      method: request.method,
      status,
      headersJson: JSON.stringify(headers),
      bodyText: text6,
      expiresAt: now + Math.max(1, finalCacheTtlMs),
      updatedAt: now
    });
  }
  return text6;
}
async function fetchTextResponse(url, init, options) {
  const host = new URL(url).hostname.toLowerCase();
  const concurrency = options?.domainConcurrency ?? DEFAULT_DOMAIN_CONCURRENCY;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_EXTERNAL_HTTP_TIMEOUT_MS;
  return runWithDomainLimit(host, concurrency, timeoutMs, async () => {
    const attempts = isRetryableMethod(init?.method) ? 2 : 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const attemptInit = withTimeoutSignal(init, timeoutMs);
      try {
        if (shouldUseProxy(url, options)) {
          return await fetchTextViaProxy(url, attemptInit, options);
        }
        return await fetchTextDirect(url, attemptInit);
      } catch (err) {
        lastError = isTimeoutError(err) ? new ExternalRequestTimeoutError(host, timeoutMs, { cause: err }) : err;
        if (attempt >= attempts || !isRetryableNetworkError(lastError)) {
          throw lastError;
        }
        console.warn(
          `external request failed for ${host}; retrying with a new request (attempt ${attempt}/${attempts}):`,
          lastError
        );
      }
    }
    throw lastError;
  });
}
function withTimeoutSignal(init, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
  };
}
async function fetchTextDirect(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; stock-info-worker/0.1; +https://workers.cloudflare.com/)",
      ...init?.headers ?? {}
    }
  });
  const text6 = await res.text();
  if (!res.ok) {
    throw new Error(`request failed: status=${res.status} body=${truncate(text6)}`);
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: text6 };
}
function isRetryableMethod(method) {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}
function isRetryableNetworkError(err) {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  if (err.retryable === true) {
    return true;
  }
  const message2 = err instanceof Error ? err.message : String(err);
  return /network connection lost|fetch failed|connection reset|socket closed|timed out|timeout/i.test(message2);
}
function isTimeoutError(err) {
  return err instanceof Error && err.name === "TimeoutError";
}
async function fetchTextViaProxy(url, init, options) {
  if (!options?.proxyRelayUrl) {
    throw new Error("HTTP_PROXY_RELAY_URL is required when HTTP proxying is enabled");
  }
  return fetchTextViaProxyRelay(options.proxyRelayUrl, url, init);
}
async function fetchTextViaProxyRelay(relayUrl, url, init) {
  const res = await fetch(relayUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: init?.signal,
    body: JSON.stringify({
      url,
      method: init?.method ?? "GET",
      headers: normalizeOutgoingHeaders(init?.headers),
      body: typeof init?.body === "string" ? init.body : void 0
    })
  });
  const text6 = await res.text();
  if (!res.ok) {
    throw new Error(`proxy relay request failed: status=${res.status} body=${truncate(text6)}`);
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: text6 };
}
function externalHttpOptions(env) {
  return {
    proxyEnabled: Boolean(env.HTTP_PROXY_URL),
    proxyUrl: env.HTTP_PROXY_URL,
    proxyRelayUrl: env.HTTP_PROXY_RELAY_URL,
    proxyDomains: parseDomains(env.HTTP_PROXY_DOMAINS),
    domainConcurrency: positiveInt(env.HTTP_DOMAIN_CONCURRENCY) ?? DEFAULT_DOMAIN_CONCURRENCY,
    timeoutMs: positiveInt(env.HTTP_REQUEST_TIMEOUT_MS) ?? DEFAULT_EXTERNAL_HTTP_TIMEOUT_MS
  };
}
function shouldUseProxy(url, options) {
  if (!options?.proxyUrl || options.proxyEnabled === false) {
    return false;
  }
  const domains = options.proxyDomains ?? [];
  if (domains.length === 0) {
    return false;
  }
  const host = new URL(url).hostname.toLowerCase();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
function parseDomains(value) {
  const values2 = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
  return values2.map((item) => item.trim().toLowerCase().replace(/^\./, "")).filter(Boolean);
}
function positiveInt(value) {
  if (!value) return void 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : void 0;
}
async function runWithDomainLimit(host, concurrency, timeoutMs, fn) {
  const limit = Math.max(1, concurrency || DEFAULT_DOMAIN_CONCURRENCY);
  let limiter = domainLimiters.get(host);
  if (!limiter || limiter.limit !== limit) {
    limiter = new DomainLimiter(limit);
    domainLimiters.set(host, limiter);
  }
  return limiter.run(fn, host, timeoutMs);
}
var DomainLimiter = class {
  constructor(limit) {
    this.limit = limit;
  }
  limit;
  slots = /* @__PURE__ */ new Map();
  async run(fn, host, timeoutMs) {
    const token = Symbol(host);
    const deadline = Date.now() + timeoutMs;
    const leaseMs = Math.max(timeoutMs * 3, timeoutMs + 1e3);
    while (true) {
      const now = Date.now();
      this.pruneExpiredSlots(now);
      if (this.slots.size < this.limit) {
        this.slots.set(token, now + leaseMs);
        break;
      }
      const remainingMs = deadline - now;
      if (remainingMs <= 0) {
        throw new ExternalConcurrencyTimeoutError(host, this.limit, timeoutMs);
      }
      await delay(Math.min(25, remainingMs));
    }
    try {
      return await fn();
    } finally {
      this.slots.delete(token);
    }
  }
  pruneExpiredSlots(now) {
    for (const [token, expiresAt] of this.slots) {
      if (expiresAt <= now) {
        this.slots.delete(token);
      }
    }
  }
};
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function parseJsonOrJsonp(text6) {
  const trimmed = text6.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  const start = trimmed.indexOf("(");
  const end = trimmed.lastIndexOf(")");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start + 1, end));
  }
  throw new Error(`invalid json/jsonp body: ${truncate(trimmed)}`);
}
function numberOrNull(value) {
  if (value === null || value === void 0 || value === "") {
    return null;
  }
  if (typeof value === "object" && "raw" in value) {
    return numberOrNull(value.raw);
  }
  const num = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
  return Number.isFinite(num) ? num : null;
}
function truncate(value, max = 300) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
function normalizeRequest(url, init) {
  return {
    method: (init?.method ?? "GET").toUpperCase(),
    url,
    headers: normalizeHeaders(init?.headers),
    body: typeof init?.body === "string" ? init.body : null
  };
}
function normalizeHeaders(headers) {
  const result = {};
  if (!headers) {
    return result;
  }
  const entries = headers instanceof Headers ? [...headers.entries()] : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key, value] of entries) {
    const lowered = key.toLowerCase();
    if (lowered === "authorization" || lowered === "cookie") {
      result[lowered] = "<redacted>";
    } else {
      result[lowered] = String(value);
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
function normalizeOutgoingHeaders(headers) {
  const result = {};
  if (!headers) {
    return result;
  }
  const entries = headers instanceof Headers ? [...headers.entries()] : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key, value] of entries) {
    result[key] = String(value);
  }
  return result;
}
async function digestHex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

// src/shared/taskd-webqa-result.ts
function extractTaskdWebQaResult(value) {
  const result = record(value);
  if (result?.format !== "taskd.webqa.result.v2") {
    throw new Error("taskd WebQA result must use taskd.webqa.result.v2");
  }
  const content = record(result.content);
  if (content?.format !== "web-helper.rich-content.v1" || typeof content.markdown !== "string" || !Array.isArray(content.assets)) {
    throw new Error("taskd WebQA result must include web-helper.rich-content.v1 content");
  }
  if (!Array.isArray(result.citations) || !Array.isArray(result.sources)) {
    throw new Error("taskd WebQA result must preserve citations and sources arrays");
  }
  const rawSnapshot = record(result.raw_snapshot);
  const terminalEvidence = record(result.terminal_evidence);
  const execution = record(result.execution);
  if (!rawSnapshot || !terminalEvidence || !execution) {
    throw new Error("taskd WebQA result must preserve raw_snapshot, terminal_evidence, and execution");
  }
  return {
    format: "taskd.webqa.result.v2",
    content: {
      format: "web-helper.rich-content.v1",
      markdown: content.markdown,
      assets: content.assets
    },
    citations: result.citations,
    sources: result.sources,
    rawSnapshot,
    terminalEvidence,
    execution
  };
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// src/shared/llm-client.ts
function taskdWebQaInput(env, request, name) {
  return {
    platform: env.TASKD_NAMESPACE || "stock-info",
    conversation_id: `stock-info:${name}`,
    provider: "chatgpt-web",
    input: renderPrompt(request.messages),
    ...request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {},
    new_session: true,
    timeout_ms: boundedPositive(request.waitTimeoutMs, 60 * 6e4, 24 * 60 * 6e4),
    mode: "ask"
  };
}
function renderPrompt(messages) {
  const rendered = messages.map((message2) => ({ role: message2.role, content: string(message2.content) })).filter((message2) => message2.content).map((message2) => message2.content);
  if (rendered.length === 0) throw new Error("LLM request requires at least one non-empty message");
  return rendered.join("\n\n");
}
function boundedPositive(value, fallback, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}
function text(value) {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}
function string(value) {
  return text(value);
}

// ../shared-ts/packages/taskd-client/dist/index.js
function createTaskdCallerClient(options) {
  const baseUrl = required(options.baseUrl, "TASKD_BASE_URL").replace(/\/+$/, "");
  const namespace = required(options.namespace, "TASKD_NAMESPACE");
  const token = required(options.token, "TASKD_CALLER_TOKEN");
  const tokenSource = text2(options.tokenSource) || "configured";
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const namespacePrefix = `${baseUrl}/v1/namespaces/${encodeURIComponent(namespace)}`;
  const prefix = `${namespacePrefix}/tasks`;
  async function request(path, init = {}, diagnostics = {}) {
    let response;
    const method = text2(init.method) || "GET";
    const url = path.startsWith("~") ? `${namespacePrefix}${path.slice(1)}` : `${prefix}${path}`;
    const requestedAt = isoTimestamp(now());
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...init.body ? { "content-type": "application/json" } : {}, ...init.headers }
      });
    } catch (error) {
      throw new Error(`taskd request failed: ${requestErrorMessage(error)}${formatDiagnostics({ method, url, namespace, tokenSource, token: maskToken(token), requestedAt, errorName: error instanceof Error ? error.name : void 0, errorCode: requestErrorCode(error), errorCause: errorCauseMessage(error), ...diagnostics })}`);
    }
    const { body, rawText } = await parseTaskdResponseBody(response);
    return { response, body, rawText, requestedAt };
  }
  async function taskRequest(path, init, diagnostics = {}) {
    const { response, body, rawText, requestedAt } = await request(path, init, diagnostics);
    if (response.status === 404)
      return null;
    if (!response.ok)
      throw new Error(`taskd returned ${response.status}: ${message(body, rawText) || response.statusText}${formatDiagnostics({ status: response.status, statusText: response.statusText, requestedAt, responseCode: responseCode(body), responseReason: responseReason(body, rawText) })}`);
    return normalizeTask(body);
  }
  return {
    async availability(taskType) {
      const normalizedTaskType = required(taskType, "taskd task type");
      const { response, body, rawText, requestedAt } = await request(`~/executors/availability?task_type=${encodeURIComponent(normalizedTaskType)}`, void 0, { action: "availability", taskType: normalizedTaskType });
      if (!response.ok)
        throw new Error(`taskd returned ${response.status}: ${message(body, rawText) || response.statusText}${formatDiagnostics({ status: response.status, statusText: response.statusText, requestedAt, responseCode: responseCode(body), responseReason: responseReason(body, rawText) })}`);
      return normalizeAvailability(body, namespace, normalizedTaskType);
    },
    async submit(input) {
      const name = required(input.name, "taskd task name");
      const taskType = required(input.taskType, "taskd task type");
      const task = await taskRequest("", { method: "POST", body: JSON.stringify({ client_task_name: name, task_type: taskType, input: input.payload }) }, { action: "submit", taskName: name, taskType, ...taskPayloadDiagnostics(input.payload), ...input.diagnostics });
      if (!task)
        throw new Error("taskd submit returned no task");
      return task;
    },
    get(name) {
      const normalizedName = required(name, "taskd task name");
      return taskRequest(`/by-name/${encodeURIComponent(normalizedName)}`, void 0, { action: "get", taskName: normalizedName });
    },
    recover(name) {
      const normalizedName = required(name, "taskd task name");
      return taskRequest(`/by-name/${encodeURIComponent(normalizedName)}/recover`, { method: "POST" }, { action: "recover", taskName: normalizedName });
    },
    interrupt(name) {
      const normalizedName = required(name, "taskd task name");
      return taskRequest(`/by-name/${encodeURIComponent(normalizedName)}/interrupt`, { method: "POST" }, { action: "interrupt", taskName: normalizedName });
    },
    async delete(name) {
      const normalizedName = required(name, "taskd task name");
      const { response, body, rawText, requestedAt } = await request(`/by-name/${encodeURIComponent(normalizedName)}`, { method: "DELETE" }, { action: "delete", taskName: normalizedName });
      if (response.status === 404)
        return false;
      if (response.status !== 204)
        throw new Error(`taskd returned ${response.status}: ${message(body, rawText) || response.statusText}${formatDiagnostics({ status: response.status, statusText: response.statusText, requestedAt, responseCode: responseCode(body), responseReason: responseReason(body, rawText) })}`);
      return true;
    }
  };
}
function normalizeAvailability(value, expectedNamespace, expectedTaskType) {
  const row = record2(value);
  const namespace = required(text2(row.namespace), "taskd availability namespace");
  const taskType = required(text2(row.task_type), "taskd availability task_type");
  if (namespace !== expectedNamespace || taskType !== expectedTaskType)
    throw new Error("taskd availability response did not match requested capability");
  return {
    namespace,
    taskType,
    online: Boolean(row.online),
    available: Boolean(row.available),
    onlineExecutorCount: nonNegativeInteger(row.online_executor_count, "taskd online_executor_count"),
    availableExecutorCount: nonNegativeInteger(row.available_executor_count, "taskd available_executor_count"),
    availableSlotCount: nonNegativeInteger(row.available_slot_count, "taskd available_slot_count")
  };
}
function normalizeTask(value) {
  const row = record2(value);
  const status = required(text2(row.status), "taskd task status");
  if (!(/* @__PURE__ */ new Set(["queued", "leased", "running", "interrupt_requested", "succeeded", "failed", "interrupted", "superseded"])).has(status))
    throw new Error(`taskd returned unsupported status: ${status}`);
  return { taskId: integer(row.task_id, "taskd task_id"), namespace: required(text2(row.namespace), "taskd namespace"), name: required(text2(row.client_task_name), "taskd client_task_name"), taskType: required(text2(row.task_type), "taskd task_type"), input: row.input, status, checkpoint: row.checkpoint ?? null, result: row.result ?? null, errorMessage: text2(row.error_message) || null, supersededByTaskId: optionalInteger(row.superseded_by_task_id), createdAt: integer(row.created_at, "taskd created_at"), updatedAt: integer(row.updated_at, "taskd updated_at"), completedAt: optionalInteger(row.completed_at) };
}
function required(value, label) {
  const normalized = value.trim();
  if (!normalized)
    throw new Error(`${label} is required`);
  return normalized;
}
function record2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("taskd returned a non-object response");
  return value;
}
function text2(value) {
  return typeof value === "string" ? value.trim() : "";
}
function integer(value, label) {
  const numberValue2 = Number(value);
  if (!Number.isInteger(numberValue2) || numberValue2 < 1)
    throw new Error(`${label} is invalid`);
  return numberValue2;
}
function nonNegativeInteger(value, label) {
  const numberValue2 = Number(value);
  if (!Number.isInteger(numberValue2) || numberValue2 < 0)
    throw new Error(`${label} is invalid`);
  return numberValue2;
}
function optionalInteger(value) {
  if (value === null || value === void 0)
    return null;
  return integer(value, "taskd integer");
}
async function parseTaskdResponseBody(response) {
  const rawText = await response.text().catch(() => "");
  const trimmed = rawText.trim();
  if (!trimmed)
    return { body: null, rawText: "" };
  try {
    return { body: JSON.parse(trimmed), rawText };
  } catch {
    return { body: null, rawText };
  }
}
function message(value, rawText = "") {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  return text2(row?.error) || text2(row?.message) || text2(row?.reason) || truncateDiagnostic(rawText);
}
function responseCode(value) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  return text2(row?.code) || text2(row?.error_code) || text2(row?.errorCode);
}
function responseReason(value, rawText = "") {
  return message(value, rawText);
}
function taskPayloadDiagnostics(value) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  return { provider: text2(row?.provider) || void 0, platform: text2(row?.platform) || void 0, conversationId: text2(row?.conversation_id) || void 0, reasoningEffort: text2(row?.reasoning_effort) || void 0, timeoutMs: numericDiagnostic(row?.timeout_ms), mode: text2(row?.mode) || void 0 };
}
function numericDiagnostic(value) {
  const numberValue2 = Number(value);
  return Number.isFinite(numberValue2) ? numberValue2 : void 0;
}
function maskToken(value) {
  if (!value)
    return "missing";
  if (value.length <= 8)
    return `present(len=${value.length})`;
  return `present(len=${value.length},last4=${value.slice(-4)})`;
}
function requestErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function requestErrorCode(error) {
  const explicit = error && typeof error === "object" ? text2(error.code) : "";
  if (explicit)
    return explicit;
  const name = error instanceof Error ? error.name : "";
  const detail = requestErrorMessage(error);
  if (/fetch failed/i.test(detail))
    return "network_fetch_failed";
  if (name === "AbortError")
    return "abort_error";
  if (name === "TimeoutError")
    return "timeout_error";
  return "";
}
function errorCauseMessage(error) {
  const cause = error && typeof error === "object" ? error.cause : void 0;
  if (cause instanceof Error)
    return cause.message;
  return typeof cause === "string" ? cause.trim() : "";
}
function truncateDiagnostic(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 160);
}
function isoTimestamp(value) {
  return new Date(value).toISOString();
}
function formatDiagnostics(value) {
  const parts = Object.entries(value).flatMap(([key, item]) => {
    const normalized = diagnosticValue(item);
    return normalized ? [`${key}=${normalized}`] : [];
  });
  return parts.length ? ` [${parts.join(" ")}]` : "";
}
function diagnosticValue(value) {
  if (value === null || value === void 0)
    return "";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean")
    return value ? "true" : "false";
  const normalized = typeof value === "string" ? truncateDiagnostic(value) : "";
  return normalized ? normalized.slice(0, 160) : "";
}

// src/shared/taskd-client.ts
function taskdCallerClient(env) {
  if (env.LLM_RUNTIME !== "local") throw new Error("taskd caller is only available in local LLM runtime");
  const token = env.STOCK_INFO_TASKD_CALLER_TOKEN || env.TASKD_CALLER_TOKEN || "";
  if (!token) throw new Error("STOCK_INFO_TASKD_CALLER_TOKEN is required");
  return createTaskdCallerClient({
    baseUrl: env.TASKD_BASE_URL || "",
    namespace: env.TASKD_NAMESPACE || "stock-info",
    // TASKD_CALLER_TOKEN is taskd's generic caller-secret name. Keep the
    // stock-info name first so existing local credential files remain valid.
    token,
    tokenSource: env.STOCK_INFO_TASKD_CALLER_TOKEN ? "STOCK_INFO_TASKD_CALLER_TOKEN" : env.TASKD_CALLER_TOKEN ? "TASKD_CALLER_TOKEN" : "missing"
  });
}

// src/shared/taskd-result-projection.ts
async function reconcileTaskdResult(client, projection) {
  const task = await client.get(projection.name);
  if (!task) return { state: "missing" };
  switch (task.status) {
    case "succeeded":
      if (task.result === null) throw new Error(`taskd succeeded task ${task.name} has no result`);
      return { state: "projected", task, value: await projection.project(task) };
    case "failed":
      return { state: "failed", task };
    case "interrupted":
      return { state: "interrupted", task };
    case "superseded":
      return { state: "superseded", task };
    default:
      return { state: "pending", task };
  }
}

// shared/finance-mappings.json
var finance_mappings_default = {
  marketMap: {
    SZ: 0,
    BJ: 0,
    SH: 1,
    ZF: 0,
    SF: 1,
    ZI: 0,
    SI: 1,
    HI: 2,
    SO: 10,
    ZO: 12,
    LO: -1,
    OF: 150,
    HK: 116,
    O: 105,
    N: 106,
    AF: 107
  },
  usCodeMap: {
    "PDD.US": "PDD.O",
    "BEKE.US": "BEKE.N"
  },
  bankCodes: [
    "000001.SZ",
    "600000.SH",
    "601398.SH",
    "601939.SH",
    "601288.SH",
    "601166.SH",
    "601328.SH",
    "601169.SH",
    "600036.SH",
    "601988.SH",
    "601818.SH",
    "600015.SH",
    "600016.SH",
    "601997.SH",
    "002142.SZ",
    "601998.SH",
    "601229.SH",
    "600919.SH",
    "601009.SH",
    "600926.SH",
    "601916.SH",
    "601825.SH",
    "601658.SH",
    "601860.SH",
    "002839.SZ",
    "601577.SH",
    "002807.SH",
    "601963.SH",
    "002958.SZ",
    "002936.SZ",
    "002948.SZ",
    "601665.SH",
    "601187.SH",
    "600928.SH",
    "601231.SH",
    "601838.SH",
    "002966.SZ",
    "601128.SH",
    "603323.SH",
    "601077.SH",
    "601528.SH"
  ],
  securityCodes: [
    "600030.SH",
    "600999.SH",
    "601211.SH",
    "601377.SH",
    "601688.SH",
    "000776.SZ"
  ],
  insuranceCodes: [
    "601318.SH",
    "601601.SH",
    "601628.SH",
    "601336.SH"
  ],
  ignoreKeys: [
    "CONVERT_DIFF",
    "OPERATE_PROFIT_BALANCE",
    "ABLE_OCI",
    "CURRENT_ASSET_BALANCE",
    "LIAB_BALANCE",
    "NONCURRENT_ASSET_BALANCE",
    "NONCURRENT_LIAB_BALANCE",
    "CURRENT_LIAB_BALANCE",
    "PARENT_EQUITY_BALANCE",
    "EQUITY_BALANCE",
    "ASSET_BALANCE",
    "\u57FA\u672C\u52A0\u6743\u5E73\u5747\u80A1\u6570-\u666E\u901A\u80A1",
    "\u644A\u8584\u52A0\u6743\u5E73\u5747\u80A1\u6570-\u666E\u901A\u80A1",
    "\u975E\u8FD0\u7B97\u9879\u76EE",
    "\u5176\u4ED6\u50A8\u5907",
    "\u603B\u6743\u76CA\u53CA\u975E\u6D41\u52A8\u8D1F\u503A",
    "\u51C0\u6D41\u52A8\u8D44\u4EA7",
    "\u603B\u8D44\u4EA7\u51CF\u6D41\u52A8\u8D1F\u503A",
    "\u51C0\u8D44\u4EA7",
    "\u603B\u8D44\u4EA7\u51CF\u603B\u8D1F\u503A\u5408\u8BA1",
    "\u80A1\u4E1C\u6743\u76CA\u5176\u4ED6\u9879\u76EE",
    "\u53EF\u8F6C\u6362\u53EF\u8D4E\u56DE\u4F18\u5148\u80A1",
    "\u4F18\u5148\u80A1",
    "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u6743\u76CA\u5176\u4ED6\u9879\u76EE"
  ],
  coreKeys: [
    [
      "totalOperateIncome",
      "\u8425\u4E1A\u603B\u6536\u5165"
    ],
    [
      "netProfit",
      "\u51C0\u5229\u6DA6"
    ],
    [
      "roa",
      "\u603B\u8D44\u4EA7\u6536\u76CA\u7387(%)"
    ],
    [
      "roe",
      "\u51C0\u8D44\u4EA7\u6536\u76CA\u7387(%)"
    ],
    [
      "grossProfitRatio",
      "\u6BDB\u5229\u6DA6\u7387(%)"
    ],
    [
      "netProfitRatio",
      "\u51C0\u5229\u6DA6\u7387(%)"
    ],
    [
      "totalAssetsTurnover",
      "\u603B\u8D44\u4EA7\u5468\u8F6C\u7387"
    ],
    [
      "assetLiabRatio",
      "\u8D44\u4EA7\u8D1F\u503A\u7387(%)"
    ],
    [
      "equityMultiplier",
      "\u6743\u76CA\u4E58\u6570"
    ]
  ],
  incomeKeys: [
    [
      "totalOperateIncome",
      "\u8425\u4E1A\u603B\u6536\u5165",
      "TOTAL_OPERATE_INCOME",
      "\u8425\u8FD0\u6536\u5165",
      "\u8425\u4E1A\u6536\u5165",
      "info"
    ],
    [
      "operateIncome",
      "\u8425\u4E1A\u6536\u5165",
      "OPERATE_INCOME",
      "\u8425\u4E1A\u989D",
      "\u4E3B\u8425\u6536\u5165"
    ],
    [
      "interestIncome",
      "\u5229\u606F\u6536\u5165",
      "INTEREST_INCOME",
      "",
      ""
    ],
    [
      "feeCommissionIncome",
      "\u624B\u7EED\u8D39\u53CA\u4F63\u91D1\u6536\u5165",
      "FEE_COMMISSION_INCOME",
      "",
      ""
    ],
    [
      "otherBusinessIncome",
      "\u5176\u4ED6\u4E1A\u52A1\u6536\u5165",
      "OTHER_BUSINESS_INCOME",
      "\u5176\u4ED6\u8425\u4E1A\u6536\u5165",
      "\u5176\u4ED6\u4E1A\u52A1\u6536\u5165"
    ],
    [
      "totalOperateCost",
      "\u8425\u4E1A\u603B\u6210\u672C",
      "TOTAL_OPERATE_COST",
      "\u8425\u8FD0\u652F\u51FA",
      "\u8425\u4E1A\u6210\u672C",
      "info"
    ],
    [
      "operateCost",
      "\u8425\u4E1A\u6210\u672C",
      "OPERATE_COST",
      "\u9500\u552E\u6210\u672C",
      "\u4E3B\u8425\u6210\u672C"
    ],
    [
      "grossProfit",
      "\u6BDB\u5229",
      "",
      "\u6BDB\u5229",
      "\u6BDB\u5229"
    ],
    [
      "interestExpense",
      "\u5229\u606F\u652F\u51FA",
      "INTEREST_EXPENSE",
      "",
      ""
    ],
    [
      "feeCommissionExpense",
      "\u624B\u7EED\u8D39\u53CA\u4F63\u91D1\u652F\u51FA",
      "FEE_COMMISSION_EXPENSE",
      "",
      ""
    ],
    [
      "operateTaxAdd",
      "\u8425\u4E1A\u7A0E\u91D1\u53CA\u9644\u52A0",
      "OPERATE_TAX_ADD"
    ],
    [
      "totalOperateExpense",
      "\u8425\u4E1A\u603B\u8D39\u7528",
      "",
      "",
      "\u8425\u4E1A\u8D39\u7528",
      "info"
    ],
    [
      "saleExpense",
      "\u9500\u552E\u8D39\u7528",
      "SALE_EXPENSE",
      "\u9500\u552E\u53CA\u5206\u9500\u8D39\u7528",
      "\u8425\u9500\u8D39\u7528"
    ],
    [
      "manageExpense",
      "\u7BA1\u7406\u8D39\u7528",
      "MANAGE_EXPENSE",
      "\u884C\u653F\u5F00\u652F",
      "\u4E00\u822C\u53CA\u884C\u653F\u8D39\u7528"
    ],
    [
      "researchExpense",
      "\u7814\u53D1\u8D39\u7528",
      "RESEARCH_EXPENSE",
      "\u7814\u53D1\u8D39\u7528",
      "\u7814\u53D1\u8D39\u7528"
    ],
    [
      "financeExpense",
      "\u8D22\u52A1\u8D39\u7528",
      "FINANCE_EXPENSE",
      "\u878D\u8D44\u6210\u672C"
    ],
    [
      "feInterestExpense",
      "\u5176\u4E2D:\u5229\u606F\u8D39\u7528",
      "FE_INTEREST_EXPENSE",
      "",
      "\u5229\u606F\u652F\u51FA"
    ],
    [
      "feInterestIncome",
      "\u5176\u4E2D:\u5229\u606F\u6536\u5165",
      "FE_INTEREST_INCOME",
      "\u5229\u606F\u6536\u5165",
      "\u5229\u606F\u6536\u5165"
    ],
    [
      "assetImpairmentLoss",
      "\u8D44\u4EA7\u51CF\u503C\u635F\u5931(\u65E7)",
      "ASSET_IMPAIRMENT_LOSS",
      "\u51CF\u503C\u53CA\u62E8\u5907",
      "\u51CF\u503C\u53CA\u62E8\u5907"
    ],
    [
      "creditImpairmentLoss",
      "\u4FE1\u7528\u51CF\u503C\u635F\u5931(\u65E7)",
      "CREDIT_IMPAIRMENT_LOSS"
    ],
    [
      "fairvalueChangeIncome",
      "\u52A0:\u516C\u5141\u4EF7\u503C\u53D8\u52A8\u6536\u76CA",
      "FAIRVALUE_CHANGE_INCOME",
      "\u91CD\u4F30\u76C8\u4F59",
      "\u516C\u5141\u4EF7\u503C\u53D8\u52A8\u635F\u76CA"
    ],
    [
      "equityInvestIncome",
      "\u6743\u76CA\u6027\u6295\u8D44\u635F\u76CA",
      "",
      "\u6EA2\u5229\u5176\u4ED6\u9879\u76EE",
      "\u6743\u76CA\u6027\u6295\u8D44\u635F\u76CA"
    ],
    [
      "investIncome",
      "\u6295\u8D44\u6536\u76CA",
      "INVEST_INCOME",
      "",
      "\u6295\u8D44\u6027\u51CF\u503C\u51C6\u5907"
    ],
    [
      "investJointIncome",
      "\u5176\u4E2D:\u5BF9\u8054\u8425\u4F01\u4E1A\u548C\u5408\u8425\u4F01\u4E1A\u7684\u6295\u8D44\u6536\u76CA",
      "INVEST_JOINT_INCOME",
      "\u5E94\u5360\u8054\u8425\u516C\u53F8\u6EA2\u5229"
    ],
    [
      "assetDisposalIncome",
      "\u8D44\u4EA7\u5904\u7F6E\u6536\u76CA",
      "ASSET_DISPOSAL_INCOME"
    ],
    [
      "assetImpairmentIncome",
      "\u8D44\u4EA7\u51CF\u503C\u635F\u5931(\u65B0)",
      "ASSET_IMPAIRMENT_INCOME"
    ],
    [
      "creditImpairmentIncome",
      "\u4FE1\u7528\u51CF\u503C\u635F\u5931(\u65B0)",
      "CREDIT_IMPAIRMENT_INCOME"
    ],
    [
      "exchangeIncome",
      "\u6C47\u5151\u635F\u76CA",
      "",
      "",
      "\u6C47\u5151\u635F\u76CA"
    ],
    [
      "otherIncome",
      "\u5176\u4ED6\u6536\u76CA",
      "OTHER_INCOME",
      "\u5176\u4ED6\u6536\u76CA",
      "\u5176\u4ED6\u6536\u5165(\u652F\u51FA)"
    ],
    [
      "operateProfit",
      "\u8425\u4E1A\u5229\u6DA6",
      "OPERATE_PROFIT",
      "\u7ECF\u8425\u6EA2\u5229",
      "\u8425\u4E1A\u5229\u6DA6",
      "info"
    ],
    [
      "nonbusinessIncome",
      "\u52A0:\u8425\u4E1A\u5916\u6536\u5165",
      "NONBUSINESS_INCOME",
      "\u5176\u5B83\u6536\u5165"
    ],
    [
      "noneCurrentDisposalIncome",
      "\u5176\u4E2D:\u975E\u6D41\u52A8\u8D44\u4EA7\u5904\u7F6E\u5229\u5F97",
      "NONCURRENT_DISPOSAL_INCOME"
    ],
    [
      "nonbusinessExpense",
      "\u51CF:\u8425\u4E1A\u5916\u652F\u51FA",
      "NONBUSINESS_EXPENSE",
      "\u5176\u4ED6\u652F\u51FA"
    ],
    [
      "noneCurrentDisposalLoss",
      "\u5176\u4E2D:\u975E\u6D41\u52A8\u8D44\u4EA7\u5904\u7F6E\u51C0\u635F\u5931",
      "NONCURRENT_DISPOSAL_LOSS"
    ],
    [
      "totalProfit",
      "\u5229\u6DA6\u603B\u989D",
      "TOTAL_PROFIT",
      "\u9664\u7A0E\u524D\u6EA2\u5229",
      "\u6301\u7EED\u7ECF\u8425\u7A0E\u524D\u5229\u6DA6"
    ],
    [
      "incomeTax",
      "\u51CF:\u6240\u5F97\u7A0E",
      "INCOME_TAX",
      "\u7A0E\u9879",
      "\u6240\u5F97\u7A0E"
    ],
    [
      "netProfit",
      "\u51C0\u5229\u6DA6",
      "NETPROFIT",
      "\u9664\u7A0E\u540E\u6EA2\u5229",
      "\u51C0\u5229\u6DA6"
    ],
    [
      "continuedNetProfit",
      "\u6301\u7EED\u7ECF\u8425\u51C0\u5229\u6DA6",
      "CONTINUED_NETPROFIT",
      "\u6301\u7EED\u7ECF\u8425\u4E1A\u52A1\u7A0E\u540E\u5229\u6DA6",
      "\u6301\u7EED\u7ECF\u8425\u51C0\u5229\u6DA6",
      "info"
    ],
    [
      "priorityNetprofit",
      "\u5F52\u5C5E\u4E8E\u4F18\u5148\u80A1\u51C0\u5229\u6DA6\u53CA\u5176\u4ED6\u9879",
      "",
      "",
      "\u5F52\u5C5E\u4E8E\u4F18\u5148\u80A1\u51C0\u5229\u6DA6\u53CA\u5176\u4ED6\u9879"
    ],
    [
      "commonShareHoldersNetprofit",
      "\u5F52\u5C5E\u4E8E\u666E\u901A\u80A1\u80A1\u4E1C\u51C0\u5229\u6DA6",
      "",
      "",
      "\u5F52\u5C5E\u4E8E\u666E\u901A\u80A1\u80A1\u4E1C\u51C0\u5229\u6DA6"
    ],
    [
      "parentNetprofit",
      "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u7684\u51C0\u5229\u6DA6",
      "PARENT_NETPROFIT",
      "\u80A1\u4E1C\u5E94\u5360\u6EA2\u5229",
      "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u51C0\u5229\u6DA6"
    ],
    [
      "minorityInterest",
      "\u5C11\u6570\u80A1\u4E1C\u635F\u76CA",
      "MINORITY_INTEREST",
      "\u5C11\u6570\u80A1\u4E1C\u635F\u76CA",
      "\u5C11\u6570\u80A1\u4E1C\u635F\u76CA"
    ],
    [
      "deductParentNetprofit",
      "\u6263\u9664\u975E\u7ECF\u5E38\u6027\u635F\u76CA\u540E\u7684\u51C0\u5229\u6DA6",
      "DEDUCT_PARENT_NETPROFIT"
    ],
    [
      "basicEps",
      "\u57FA\u672C\u6BCF\u80A1\u6536\u76CA",
      "BASIC_EPS",
      "\u6BCF\u80A1\u57FA\u672C\u76C8\u5229",
      "\u57FA\u672C\u6BCF\u80A1\u6536\u76CA-\u666E\u901A\u80A1",
      "info"
    ],
    [
      "dilutedEps",
      "\u7A00\u91CA\u6BCF\u80A1\u6536\u76CA",
      "DILUTED_EPS",
      "\u6BCF\u80A1\u644A\u8584\u76C8\u5229",
      "\u644A\u8584\u6BCF\u80A1\u6536\u76CA-\u666E\u901A\u80A1"
    ],
    [
      "basicEpsAds",
      "\u57FA\u672C\u6BCF\u80A1\u6536\u76CA-ADS",
      "",
      "",
      "\u57FA\u672C\u6BCF\u80A1\u6536\u76CA-ADS"
    ],
    [
      "dilutedEpsAds",
      "\u644A\u8584\u6BCF\u80A1\u6536\u76CA-ADS",
      "",
      "",
      "\u644A\u8584\u6BCF\u80A1\u6536\u76CA-ADS"
    ],
    [
      "totalCompreIncome",
      "\u7EFC\u5408\u6536\u76CA\u603B\u989D",
      "TOTAL_COMPRE_INCOME",
      "\u5168\u9762\u6536\u76CA\u603B\u989D",
      "\u5168\u9762\u6536\u76CA\u603B\u989D",
      "info"
    ],
    [
      "parentTci",
      "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u7684\u7EFC\u5408\u6536\u76CA\u603B\u989D",
      "PARENT_TCI",
      "\u672C\u516C\u53F8\u62E5\u6709\u4EBA\u5E94\u5360\u5168\u9762\u6536\u76CA\u603B\u989D",
      "\u672C\u516C\u53F8\u62E5\u6709\u4EBA\u5360\u5168\u9762\u6536\u76CA\u603B\u989D"
    ],
    [
      "minorityTci",
      "\u5F52\u5C5E\u4E8E\u5C11\u6570\u80A1\u4E1C\u7684\u7EFC\u5408\u6536\u76CA\u603B\u989D",
      "MINORITY_TCI",
      "\u975E\u63A7\u80A1\u6743\u76CA\u5E94\u5360\u5168\u9762\u6536\u76CA\u603B\u989D",
      "\u975E\u63A7\u80A1\u6743\u76CA\u5360\u5168\u9762\u6536\u76CA\u603B\u989D"
    ],
    [
      "otherCompreIncome",
      "\u5176\u4ED6\u7EFC\u5408\u6536\u76CA",
      "OTHER_COMPRE_INCOME",
      "\u5176\u4ED6\u5168\u9762\u6536\u76CA",
      "\u5176\u4ED6\u5168\u9762\u6536\u76CA\u5408\u8BA1\u9879"
    ],
    [
      "otherCompreIncomeOther",
      "\u5176\u4ED6\u5168\u9762\u6536\u76CA\u5176\u4ED6\u9879\u76EE",
      "",
      "\u5176\u4ED6\u5168\u9762\u6536\u76CA\u5176\u4ED6\u9879\u76EE",
      "\u5176\u4ED6\u5168\u9762\u6536\u76CA\u5176\u4ED6\u9879\u76EE"
    ],
    [
      "parentOci",
      "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u7684\u5176\u4ED6\u7EFC\u5408\u6536\u76CA",
      "PARENT_OCI"
    ],
    [
      "minorityOci",
      "\u5F52\u5C5E\u4E8E\u5C11\u6570\u80A1\u4E1C\u7684\u5176\u4ED6\u7EFC\u5408\u6536\u76CA",
      "MINORITY_OCI"
    ]
  ],
  balanceKeys: [
    [
      "totaAssets",
      "\u8D44\u4EA7\u603B\u8BA1",
      "TOTAL_ASSETS",
      "\u603B\u8D44\u4EA7",
      "\u603B\u8D44\u4EA7",
      "info"
    ],
    [
      "totalCurrentAssets",
      "\u6D41\u52A8\u8D44\u4EA7\u5408\u8BA1",
      "TOTAL_CURRENT_ASSETS",
      "\u6D41\u52A8\u8D44\u4EA7\u5408\u8BA1",
      "\u6D41\u52A8\u8D44\u4EA7\u5408\u8BA1",
      "info"
    ],
    [
      "monetaryFunds",
      "\u8D27\u5E01\u8D44\u91D1",
      "MONETARYFUNDS",
      "\u73B0\u91D1\u53CA\u7B49\u4EF7\u7269",
      "\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269"
    ],
    [
      "restrictedMonetary",
      "\u53D7\u9650\u5236\u5B58\u6B3E\u53CA\u73B0\u91D1",
      "",
      "\u53D7\u9650\u5236\u5B58\u6B3E\u53CA\u73B0\u91D1",
      "\u9650\u5236\u6027\u73B0\u91D1\u53CA\u5176\u4ED6(\u6D41\u52A8)"
    ],
    [
      "lendFund",
      "\u62C6\u51FA\u8D44\u91D1",
      "LEND_FUND"
    ],
    [
      "tradeFinassetNotfvtpl",
      "\u4EA4\u6613\u6027\u91D1\u878D\u8D44\u4EA7",
      "TRADE_FINASSET_NOTFVTPL",
      "\u77ED\u671F\u6295\u8D44",
      "\u77ED\u671F\u6295\u8D44"
    ],
    [
      "deriveFinasset",
      "\u884D\u751F\u91D1\u878D\u8D44\u4EA7",
      "DERIVE_FINASSET"
    ],
    [
      "noteAccountsRece",
      "\u5E94\u6536\u7968\u636E\u53CA\u5E94\u6536\u8D26\u6B3E",
      "NOTE_ACCOUNTS_RECE"
    ],
    [
      "noteRece",
      "\u5176\u4E2D:\u5E94\u6536\u7968\u636E",
      "NOTE_RECE"
    ],
    [
      "accountsRece",
      "\u5176\u4E2D:\u5E94\u6536\u8D26\u6B3E",
      "ACCOUNTS_RECE",
      "\u5E94\u6536\u5E10\u6B3E",
      "\u5E94\u6536\u8D26\u6B3E"
    ],
    [
      "accountsReceToRelatedParties",
      "\u5E94\u6536\u5173\u8054\u65B9\u6B3E\u9879",
      "",
      "",
      "\u5E94\u6536\u5173\u8054\u65B9\u6B3E\u9879"
    ],
    [
      "financeRece",
      "\u5E94\u6536\u6B3E\u9879\u878D\u8D44",
      "FINANCE_RECE"
    ],
    [
      "prepayment",
      "\u9884\u4ED8\u6B3E\u9879",
      "PREPAYMENT",
      "\u9884\u4ED8\u6B3E\u6309\u91D1\u53CA\u5176\u4ED6\u5E94\u6536\u6B3E",
      "\u9884\u4ED8\u6B3E\u9879(\u6D41\u52A8)"
    ],
    [
      "totalOtherRece",
      "\u5176\u4ED6\u5E94\u6536\u6B3E\u5408\u8BA1",
      "TOTAL_OTHER_RECE"
    ],
    [
      "interestRece",
      "\u5176\u4E2D:\u5E94\u6536\u5229\u606F",
      "INTEREST_RECE"
    ],
    [
      "dividendRece",
      "\u5176\u4E2D:\u5E94\u6536\u80A1\u5229",
      "DIVIDEND_RECE"
    ],
    [
      "otherRece",
      "\u5176\u4E2D:\u5176\u4ED6\u5E94\u6536\u6B3E",
      "OTHER_RECE"
    ],
    [
      "buyResaleFinasset",
      "\u4E70\u5165\u8FD4\u552E\u91D1\u878D\u8D44\u4EA7",
      "BUY_RESALE_FINASSET"
    ],
    [
      "inventory",
      "\u5B58\u8D27",
      "INVENTORY",
      "\u5B58\u8D27"
    ],
    [
      "contractAsset",
      "\u5408\u540C\u8D44\u4EA7",
      "CONTRACT_ASSET"
    ],
    [
      "noncurrentAsset1year",
      "\u4E00\u5E74\u5185\u5230\u671F\u7684\u975E\u6D41\u52A8\u8D44\u4EA7",
      "NONCURRENT_ASSET_1YEAR"
    ],
    [
      "holdsaleAsset",
      "\u6301\u6709\u5F85\u552E\u8D44\u4EA7",
      "HOLDSALE_ASSET",
      "\u6301\u4F5C\u51FA\u552E\u7684\u8D44\u4EA7(\u6D41\u52A8)"
    ],
    [
      "otherCurrentAsset",
      "\u5176\u4ED6\u6D41\u52A8\u8D44\u8D44\u4EA7",
      "OTHER_CURRENT_ASSET"
    ],
    [
      "totalNoncurrentAssets",
      "\u975E\u6D41\u52A8\u8D44\u4EA7\u5408\u8BA1",
      "TOTAL_NONCURRENT_ASSETS",
      "\u975E\u6D41\u52A8\u8D44\u4EA7\u5408\u8BA1",
      "\u975E\u6D41\u52A8\u8D44\u4EA7\u5408\u8BA1",
      "info"
    ],
    [
      "loanAdvance",
      "\u53D1\u653E\u8D37\u6B3E\u53CA\u57AB\u6B3E",
      "LOAN_ADVANCE"
    ],
    [
      "creditorInvest",
      "\u503A\u6743\u6295\u8D44",
      "CREDITOR_INVEST"
    ],
    [
      "avaiableSaleFinasset",
      "\u53EF\u4F9B\u51FA\u552E\u91D1\u878D\u8D44\u4EA7",
      "AVAILABLE_SALE_FINASSET"
    ],
    [
      "longRece",
      "\u957F\u671F\u5E94\u6536\u6B3E",
      "LONG_RECE",
      "",
      "\u5176\u4ED6\u957F\u671F\u5E94\u6536\u6B3E"
    ],
    [
      "holdMaturityInvest",
      "\u6301\u6709\u81F3\u5230\u671F\u6295\u8D44",
      "HOLD_MATURITY_INVEST"
    ],
    [
      "longEquityInvest",
      "\u957F\u671F\u80A1\u6743\u6295\u8D44",
      "LONG_EQUITY_INVEST",
      "\u957F\u671F\u6295\u8D44"
    ],
    [
      "otherEquityInvest",
      "\u5176\u4ED6\u6743\u76CA\u5DE5\u5177\u6295\u8D44",
      "OTHER_EQUITY_INVEST",
      "\u5176\u4ED6\u6295\u8D44"
    ],
    [
      "otherNoncurrentFinasset",
      "\u5176\u4ED6\u975E\u6D41\u52A8\u91D1\u878D\u8D44\u4EA7",
      "OTHER_NONCURRENT_FINASSET",
      "\u6307\u5B9A\u4EE5\u516C\u5141\u4EF7\u503C\u8BB0\u8D26\u4E4B\u91D1\u878D\u8D44\u4EA7"
    ],
    [
      "investRealestate",
      "\u6295\u8D44\u6027\u623F\u5730\u4EA7",
      "INVEST_REALESTATE"
    ],
    [
      "fixedAsset",
      "\u56FA\u5B9A\u8D44\u4EA7",
      "FIXED_ASSET",
      "\u7269\u4E1A\u5382\u623F\u53CA\u8BBE\u5907",
      "\u7269\u4E1A\u3001\u5382\u623F\u53CA\u8BBE\u5907"
    ],
    [
      "cip",
      "\u5728\u5EFA\u5DE5\u7A0B",
      "CIP"
    ],
    [
      "projectMaterial",
      "\u5DE5\u7A0B\u7269\u8D44",
      "PROJECT_MATERIAL"
    ],
    [
      "userightAsset",
      "\u4F7F\u7528\u6743\u8D44\u4EA7",
      "USERIGHT_ASSET"
    ],
    [
      "productiveBiologyAsset",
      "\u751F\u4EA7\u6027\u751F\u7269\u8D44\u4EA7",
      "PRODUCTIVE_BIOLOGY_ASSET"
    ],
    [
      "fixedAssetDisposal",
      "\u56FA\u5B9A\u8D44\u4EA7\u6E05\u7406",
      "FIXED_ASSET_DISPOSAL"
    ],
    [
      "intangibleAsset",
      "\u65E0\u5F62\u8D44\u4EA7",
      "INTANGIBLE_ASSET",
      "\u65E0\u5F62\u8D44\u4EA7",
      "\u65E0\u5F62\u8D44\u4EA7"
    ],
    [
      "developExpense",
      "\u5F00\u53D1\u652F\u51FA",
      "DEVELOP_EXPENSE"
    ],
    [
      "goodwill",
      "\u5546\u8A89",
      "GOODWILL"
    ],
    [
      "longPrepaidExpense",
      "\u957F\u671F\u5F85\u644A\u8D39\u7528",
      "LONG_PREPAID_EXPENSE"
    ],
    [
      "deferTaxAsset",
      "\u9012\u5EF6\u6240\u5F97\u7A0E\u8D44\u4EA7",
      "DEFER_TAX_ASSET",
      "\u9012\u5EF6\u7A0E\u9879\u8D44\u4EA7",
      "\u9012\u5EF6\u6240\u5F97\u7A0E\u8D44\u4EA7(\u975E\u6D41\u52A8)"
    ],
    [
      "otherNoncurrentAsset",
      "\u5176\u4ED6\u975E\u6D41\u52A8\u8D44\u8D44\u4EA7",
      "OTHER_NONCURRENT_ASSET",
      "",
      "\u5176\u4ED6\u975E\u6D41\u52A8\u8D44\u4EA7"
    ],
    [
      "noncurrentAssetOther",
      "\u975E\u6D41\u52A8\u8D44\u4EA7\u5176\u4ED6\u9879\u76EE",
      "",
      "",
      "\u975E\u6D41\u52A8\u8D44\u4EA7\u5176\u4ED6\u9879\u76EE"
    ],
    [
      "totalLiabilities",
      "\u8D1F\u503A\u5408\u8BA1",
      "TOTAL_LIABILITIES",
      "\u603B\u8D1F\u503A",
      "\u603B\u8D1F\u503A",
      "info"
    ],
    [
      "totalCurrentLiab",
      "\u6D41\u52A8\u8D1F\u503A\u5408\u8BA1",
      "TOTAL_CURRENT_LIAB",
      "\u6D41\u52A8\u8D1F\u503A\u5408\u8BA1",
      "\u6D41\u52A8\u8D1F\u503A\u5408\u8BA1",
      "info"
    ],
    [
      "shortLoan",
      "\u77ED\u671F\u501F\u6B3E",
      "SHORT_LOAN",
      "\u77ED\u671F\u8D37\u6B3E"
    ],
    [
      "tradeFinliabNotfvtpl",
      "\u4EA4\u6613\u6027\u91D1\u878D\u8D1F\u503A",
      "TRADE_FINLIAB_NOTFVTPL"
    ],
    [
      "deriveFinliab",
      "\u884D\u751F\u91D1\u878D\u8D1F\u503A",
      "DERIVE_FINLIAB"
    ],
    [
      "noteAccountsPayable",
      "\u5E94\u4ED8\u7968\u636E\u53CA\u5E94\u4ED8\u8D26\u6B3E",
      "NOTE_ACCOUNTS_PAYABLE"
    ],
    [
      "notePayable",
      "\u5176\u4E2D:\u5E94\u4ED8\u7968\u636E",
      "NOTE_PAYABLE",
      "\u5E94\u4ED8\u7968\u636E"
    ],
    [
      "accountsPayable",
      "\u5176\u4E2D:\u5E94\u4ED8\u8D26\u6B3E",
      "ACCOUNTS_PAYABLE",
      "\u5E94\u4ED8\u5E10\u6B3E",
      "\u5E94\u4ED8\u8D26\u6B3E"
    ],
    [
      "accountsPayableToRelatedparties",
      "\u5E94\u4ED8\u5173\u8054\u65B9\u6B3E\u9879(\u6D41\u52A8)",
      "",
      "\u5E94\u4ED8\u5173\u8054\u65B9\u6B3E\u9879(\u6D41\u52A8)",
      "\u5E94\u4ED8\u5173\u8054\u65B9\u6B3E\u9879(\u6D41\u52A8)"
    ],
    [
      "shortDebt",
      "\u77ED\u671F\u503A\u52A1",
      "",
      "",
      "\u77ED\u671F\u503A\u52A1"
    ],
    [
      "shortLeaseLiab",
      "\u77ED\u671F\u79DF\u8D41\u8D1F\u503A",
      "",
      "\u878D\u8D44\u79DF\u8D41\u8D1F\u503A(\u6D41\u52A8)",
      "\u8D44\u672C\u79DF\u8D41\u503A\u52A1(\u6D41\u52A8)"
    ],
    [
      "shortDeferIncome",
      "\u77ED\u671F\u9012\u5EF6\u6536\u5165",
      "",
      "\u9012\u5EF6\u6536\u5165(\u6D41\u52A8)"
    ],
    [
      "advanceReceivables",
      "\u9884\u6536\u6B3E\u9879",
      "ADVANCE_RECEIVABLES",
      "\u9884\u6536\u6B3E\u9879",
      "\u9884\u6536\u53CA\u9884\u63D0\u8D39\u7528"
    ],
    [
      "contractLiab",
      "\u5408\u540C\u8D1F\u503A",
      "CONTRACT_LIAB"
    ],
    [
      "acceptDepositInterbank",
      "\u5438\u6536\u5B58\u6B3E\u53CA\u540C\u4E1A\u5B58\u653E",
      "ACCEPT_DEPOSIT_INTERBANK"
    ],
    [
      "staffSalaryPayable",
      "\u5E94\u4ED8\u804C\u5DE5\u85AA\u916C",
      "STAFF_SALARY_PAYABLE"
    ],
    [
      "taxPayable",
      "\u5E94\u4EA4\u7A0E\u8D39",
      "TAX_PAYABLE",
      "\u5E94\u4ED8\u7A0E\u9879"
    ],
    [
      "totalOtherPayable",
      "\u5176\u4ED6\u5E94\u4ED8\u6B3E\u5408\u8BA1",
      "TOTAL_OTHER_PAYABLE",
      ""
    ],
    [
      "interestPayable",
      "\u5176\u4E2D:\u5E94\u4ED8\u5229\u606F",
      "INTEREST_PAYABLE"
    ],
    [
      "dividendPayable",
      "\u5176\u4E2D:\u5E94\u4ED8\u80A1\u5229",
      "DIVIDEND_PAYABLE"
    ],
    [
      "otherPayable",
      "\u5176\u4E2D:\u5176\u4ED6\u5E94\u4ED8\u6B3E",
      "OTHER_PAYABLE",
      "\u5176\u4ED6\u5E94\u4ED8\u6B3E\u53CA\u5E94\u8BA1\u8D39\u7528"
    ],
    [
      "noncurrentLiab1year",
      "\u4E00\u5E74\u5185\u5230\u671F\u7684\u975E\u6D41\u52A8\u8D1F\u503A",
      "NONCURRENT_LIAB_1YEAR"
    ],
    [
      "holdsaleLiab",
      "\u6301\u4F5C\u51FA\u552E\u7684\u8D1F\u503A(\u6D41\u52A8)",
      "",
      "\u6301\u4F5C\u51FA\u552E\u7684\u8D1F\u503A(\u6D41\u52A8)"
    ],
    [
      "otherCurrentLiab",
      "\u5176\u4ED6\u6D41\u52A8\u8D1F\u503A",
      "OTHER_CURRENT_LIAB",
      "\u6D41\u52A8\u8D1F\u503A\u5176\u4ED6\u9879\u76EE"
    ],
    [
      "totalNoncurrentLiab",
      "\u975E\u6D41\u52A8\u8D1F\u503A\u5408\u8BA1",
      "TOTAL_NONCURRENT_LIAB",
      "\u975E\u6D41\u52A8\u8D1F\u503A\u5408\u8BA1",
      "\u975E\u6D41\u52A8\u8D1F\u503A\u5408\u8BA1",
      "info"
    ],
    [
      "longLoan",
      "\u957F\u671F\u501F\u6B3E",
      "LONG_LOAN",
      "\u957F\u671F\u8D37\u6B3E"
    ],
    [
      "longStaffsalaryPayable",
      "\u957F\u671F\u5E94\u4ED8\u804C\u5DE5\u85AA\u916C",
      "LONG_STAFFSALARY_PAYABLE"
    ],
    [
      "bondPayable",
      "\u5E94\u4ED8\u503A\u5238",
      "BOND_PAYABLE"
    ],
    [
      "longNotePayable",
      "\u957F\u671F\u5E94\u4ED8\u7968\u636E",
      "",
      "\u5E94\u4ED8\u7968\u636E(\u975E\u6D41\u52A8)"
    ],
    [
      "leaseLiab",
      "\u79DF\u8D41\u8D1F\u503A",
      "LEASE_LIAB",
      "\u878D\u8D44\u79DF\u8D41\u8D1F\u503A(\u975E\u6D41\u52A8)",
      "\u8D44\u672C\u79DF\u8D41\u503A\u52A1(\u975E\u6D41\u52A8)"
    ],
    [
      "longPayable",
      "\u957F\u671F\u5E94\u4ED8\u6B3E",
      "LONG_PAYABLE"
    ],
    [
      "predictLiab",
      "\u9884\u8BA1\u8D1F\u503A",
      "PREDICT_LIAB"
    ],
    [
      "deferIncome",
      "\u9012\u5EF6\u6536\u76CA",
      "DEFER_INCOME",
      "\u9012\u5EF6\u6536\u5165(\u975E\u6D41\u52A8)"
    ],
    [
      "deferTaxLiab",
      "\u9012\u5EF6\u6240\u5F97\u7A0E\u8D1F\u503A",
      "DEFER_TAX_LIAB",
      "\u9012\u5EF6\u7A0E\u9879\u8D1F\u503A",
      "\u9012\u5EF6\u6240\u5F97\u7A0E\u8D1F\u503A(\u975E\u6D41\u52A8)"
    ],
    [
      "otherNoncurrentLiab",
      "\u5176\u4ED6\u975E\u6D41\u52A8\u8D1F\u503A",
      "OTHER_NONCURRENT_LIAB",
      "\u5176\u4ED6\u975E\u6D41\u52A8\u8D1F\u503A",
      "\u5176\u4ED6\u975E\u6D41\u52A8\u8D1F\u503A"
    ],
    [
      "noncurrentLiabOther",
      "\u975E\u6D41\u52A8\u8D1F\u503A\u5176\u4ED6\u9879\u76EE",
      "",
      "\u975E\u6D41\u52A8\u8D1F\u503A\u5176\u4ED6\u9879\u76EE"
    ],
    [
      "totalLiabEquity",
      "\u8D1F\u503A\u548C\u80A1\u4E1C\u6743\u76CA\u603B\u8BA1",
      "TOTAL_LIAB_EQUITY",
      "\u603B\u6743\u76CA\u53CA\u603B\u8D1F\u503A",
      "\u8D1F\u503A\u53CA\u80A1\u4E1C\u6743\u76CA\u5408\u8BA1",
      "info"
    ],
    [
      "totalEquity",
      "\u80A1\u4E1C\u6743\u76CA\u5408\u8BA1",
      "TOTAL_EQUITY",
      "\u603B\u6743\u76CA",
      "\u80A1\u4E1C\u6743\u76CA\u5408\u8BA1"
    ],
    [
      "totalParentEquity",
      "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u6743\u76CA\u603B\u8BA1",
      "TOTAL_PARENT_EQUITY",
      "\u80A1\u4E1C\u6743\u76CA",
      "\u5F52\u5C5E\u4E8E\u6BCD\u516C\u53F8\u80A1\u4E1C\u6743\u76CA"
    ],
    [
      "minorityEquity",
      "\u5C11\u6570\u80A1\u4E1C\u6743\u76CA",
      "MINORITY_EQUITY",
      "\u5C11\u6570\u80A1\u4E1C\u6743\u76CA"
    ],
    [
      "shareCapital",
      "\u5B9E\u6536\u8D44\u672C\uFF08\u6216\u80A1\u672C\uFF09",
      "SHARE_CAPITAL",
      "\u80A1\u672C",
      "\u666E\u901A\u80A1",
      "info"
    ],
    [
      "capitalReserve",
      "\u8D44\u672C\u516C\u79EF",
      "CAPITAL_RESERVE",
      "\u80A1\u672C\u6EA2\u4EF7",
      "\u80A1\u672C\u6EA2\u4EF7"
    ],
    [
      "treasuryShares",
      "\u51CF:\u5E93\u5B58\u80A1",
      "TREASURY_SHARES"
    ],
    [
      "balanceOtherCompreIncome",
      "\u5176\u4ED6\u7EFC\u5408\u6536\u76CA",
      "OTHER_COMPRE_INCOME",
      "",
      "\u5176\u4ED6\u7EFC\u5408\u6536\u76CA"
    ],
    [
      "specialReserve",
      "\u4E13\u9879\u50A8\u5907",
      "SPECIAL_RESERVE"
    ],
    [
      "surplusReserve",
      "\u76C8\u4F59\u516C\u79EF",
      "SURPLUS_RESERVE"
    ],
    [
      "unassignRpofit",
      "\u672A\u5206\u914D\u5229\u6DA6",
      "UNASSIGN_RPOFIT",
      "\u4FDD\u7559\u6EA2\u5229(\u7D2F\u8BA1\u4E8F\u635F)",
      "\u7559\u5B58\u6536\u76CA"
    ],
    [
      "generalRiskReserve",
      "\u4E00\u822C\u98CE\u9669\u51C6\u5907",
      "GENERAL_RISK_RESERVE"
    ]
  ],
  cashflowKeys: [
    [
      "netcashOperate",
      "\u7ECF\u8425\u6D3B\u52A8\u4EA7\u751F\u7684\u73B0\u91D1\u6D41\u91CF\u51C0\u989D",
      "NETCASH_OPERATE",
      "\u7ECF\u8425\u4E1A\u52A1\u73B0\u91D1\u51C0\u989D",
      "\u7ECF\u8425\u6D3B\u52A8\u4EA7\u751F\u7684\u73B0\u91D1\u6D41\u91CF\u51C0\u989D",
      "info"
    ],
    [
      "totalOperateInflow",
      "\u7ECF\u8425\u6D3B\u52A8\u73B0\u91D1\u6D41\u5165\u5C0F\u8BA1",
      "TOTAL_OPERATE_INFLOW"
    ],
    [
      "salesServices",
      "\u9500\u552E\u5546\u54C1\u3001\u63D0\u4F9B\u52B3\u52A1\u6536\u5230\u7684\u73B0\u91D1",
      "SALES_SERVICES",
      "\u7ECF\u8425\u4EA7\u751F\u73B0\u91D1"
    ],
    [
      "depositInterbankAdd",
      "\u5BA2\u6237\u5B58\u6B3E\u548C\u540C\u4E1A\u5B58\u653E\u6B3E\u9879\u51C0\u589E\u52A0\u989D",
      "DEPOSIT_INTERBANK_ADD"
    ],
    [
      "receiveInterestCommission",
      "\u6536\u53D6\u5229\u606F\u3001\u624B\u7EED\u8D39\u53CA\u4F63\u91D1\u7684\u73B0\u91D1",
      "RECEIVE_INTEREST_COMMISSION"
    ],
    [
      "receiveTaxRefund",
      "\u6536\u5230\u7684\u7A0E\u6536\u8FD4\u8FD8",
      "RECEIVE_TAX_REFUND"
    ],
    [
      "receiveOtherOperate",
      "\u6536\u5230\u5176\u4ED6\u4E0E\u7ECF\u8425\u6D3B\u52A8\u6709\u5173\u7684\u73B0\u91D1",
      "RECEIVE_OTHER_OPERATE"
    ],
    [
      "totalOperateOutflow",
      "\u7ECF\u8425\u6D3B\u52A8\u73B0\u91D1\u6D41\u51FA\u5C0F\u8BA1",
      "TOTAL_OPERATE_OUTFLOW"
    ],
    [
      "buyServices",
      "\u8D2D\u4E70\u5546\u54C1\u3001\u63A5\u53D7\u52B3\u52A1\u652F\u4ED8\u7684\u73B0\u91D1",
      "BUY_SERVICES"
    ],
    [
      "loanAdvanceAdd",
      "\u5BA2\u6237\u8D37\u6B3E\u53CA\u57AB\u6B3E\u51C0\u589E\u52A0\u989D",
      "LOAN_ADVANCE_ADD"
    ],
    [
      "pbcInterbankAdd",
      "\u5B58\u653E\u4E2D\u592E\u94F6\u884C\u548C\u540C\u4E1A\u6B3E\u9879\u51C0\u589E\u52A0\u989D",
      "PBC_INTERBANK_ADD"
    ],
    [
      "payInterestCommission",
      "\u652F\u4ED8\u5229\u606F\u3001\u624B\u7EED\u8D39\u53CA\u4F63\u91D1\u7684\u73B0\u91D1",
      "PAY_INTEREST_COMMISSION"
    ],
    [
      "payStaffCash",
      "\u652F\u4ED8\u7ED9\u804C\u5DE5\u4EE5\u53CA\u4E3A\u804C\u5DE5\u652F\u4ED8\u7684\u73B0\u91D1",
      "PAY_STAFF_CASH"
    ],
    [
      "payAllTax",
      "\u652F\u4ED8\u7684\u5404\u9879\u7A0E\u8D39",
      "PAY_ALL_TAX",
      "\u5DF2\u4ED8\u7A0E\u9879"
    ],
    [
      "payOtherOperate",
      "\u652F\u4ED8\u5176\u4ED6\u4E0E\u7ECF\u8425\u6D3B\u52A8\u6709\u5173\u7684\u73B0\u91D1",
      "PAY_OTHER_OPERATE"
    ],
    [
      "operateOutflowOther",
      "\u7ECF\u8425\u6D3B\u52A8\u73B0\u91D1\u6D41\u51FA\u7684\u5176\u4ED6\u9879\u76EE",
      "OPERATE_OUTFLOW_OTHER"
    ],
    [
      "netcashInvest",
      "\u6295\u8D44\u6D3B\u52A8\u4EA7\u751F\u7684\u73B0\u91D1\u6D41\u91CF\u51C0\u989D",
      "NETCASH_INVEST",
      "\u6295\u8D44\u4E1A\u52A1\u73B0\u91D1\u51C0\u989D",
      "\u6295\u8D44\u6D3B\u52A8\u4EA7\u751F\u7684\u73B0\u91D1\u6D41\u91CF\u51C0\u989D",
      "info"
    ],
    [
      "totalInvestInflow",
      "\u6295\u8D44\u6D3B\u52A8\u73B0\u91D1\u6D41\u5165\u5C0F\u8BA1",
      "TOTAL_INVEST_INFLOW"
    ],
    [
      "withdrawInvest",
      "\u6536\u56DE\u6295\u8D44\u6536\u5230\u7684\u73B0\u91D1",
      "WITHDRAW_INVEST",
      "\u6536\u56DE\u6295\u8D44\u6240\u5F97\u73B0\u91D1"
    ],
    [
      "receiveInvestIncome",
      "\u53D6\u5F97\u6295\u8D44\u6536\u76CA\u6536\u5230\u7684\u73B0\u91D1",
      "RECEIVE_INVEST_INCOME"
    ],
    [
      "receiveInvestDividend",
      "\u5DF2\u6536\u80A1\u606F(\u6295\u8D44)",
      "",
      "\u5DF2\u6536\u80A1\u606F(\u6295\u8D44)"
    ],
    [
      "disposalLongAsset",
      "\u5904\u7F6E\u56FA\u5B9A\u8D44\u4EA7\u3001\u65E0\u5F62\u8D44\u4EA7\u548C\u5176\u4ED6\u957F\u671F\u8D44\u4EA7\u6536\u56DE\u7684\u73B0\u91D1\u51C0\u989D",
      "DISPOSAL_LONG_ASSET",
      "\u5904\u7F6E\u56FA\u5B9A\u8D44\u4EA7"
    ],
    [
      "obtainSubsidiaryOther",
      "\u53D6\u5F97\u5B50\u516C\u53F8\u53CA\u5176\u4ED6\u8425\u4E1A\u5355\u4F4D\u652F\u4ED8\u7684\u73B0\u91D1\u51C0\u989D",
      "OBTAIN_SUBSIDIARY_OTHER"
    ],
    [
      "receiveOtherInvest",
      "\u6536\u5230\u7684\u5176\u4ED6\u4E0E\u6295\u8D44\u6D3B\u52A8\u6709\u5173\u7684\u73B0\u91D1",
      "RECEIVE_OTHER_INVEST"
    ],
    [
      "totalInvestOutflow",
      "\u6295\u8D44\u6D3B\u52A8\u73B0\u91D1\u6D41\u51FA\u5C0F\u8BA1",
      "TOTAL_INVEST_OUTFLOW"
    ],
    [
      "constructLongAsset",
      "\u8D2D\u5EFA\u56FA\u5B9A\u8D44\u4EA7\u3001\u65E0\u5F62\u8D44\u4EA7\u548C\u5176\u4ED6\u957F\u671F\u8D44\u4EA7\u652F\u4ED8\u7684\u73B0\u91D1",
      "CONSTRUCT_LONG_ASSET",
      "\u8D2D\u5EFA\u56FA\u5B9A\u8D44\u4EA7"
    ],
    [
      "investPayCash",
      "\u6295\u8D44\u652F\u4ED8\u7684\u73B0\u91D1",
      "INVEST_PAY_CASH",
      "\u6295\u8D44\u652F\u4ED8\u73B0\u91D1"
    ],
    [
      "payOtherInvest",
      "\u652F\u4ED8\u5176\u4ED6\u4E0E\u6295\u8D44\u6D3B\u52A8\u6709\u5173\u7684\u73B0\u91D1",
      "PAY_OTHER_INVEST"
    ],
    [
      "netcashFinance",
      "\u7B79\u8D44\u6D3B\u52A8\u4EA7\u751F\u7684\u73B0\u91D1\u6D41\u91CF\u51C0\u989D",
      "NETCASH_FINANCE",
      "\u878D\u8D44\u4E1A\u52A1\u73B0\u91D1\u51C0\u989D",
      "\u7B79\u8D44\u6D3B\u52A8\u4EA7\u751F\u7684\u73B0\u91D1\u6D41\u91CF\u51C0\u989D",
      "info"
    ],
    [
      "totalFinanceInflow",
      "\u7B79\u8D44\u6D3B\u52A8\u73B0\u91D1\u6D41\u5165\u5C0F\u8BA1",
      "TOTAL_FINANCE_INFLOW"
    ],
    [
      "acceptInvestCash",
      "\u5438\u6536\u6295\u8D44\u6536\u5230\u7684\u73B0\u91D1",
      "ACCEPT_INVEST_CASH"
    ],
    [
      "subsidiaryAcceptInvest",
      "\u5176\u4E2D:\u5B50\u516C\u53F8\u5438\u6536\u5C11\u6570\u80A1\u4E1C\u6295\u8D44\u6536\u5230\u7684\u73B0\u91D1",
      "SUBSIDIARY_ACCEPT_INVEST"
    ],
    [
      "receiveLoanCash",
      "\u53D6\u5F97\u501F\u6B3E\u6536\u5230\u7684\u73B0\u91D1",
      "RECEIVE_LOAN_CASH"
    ],
    [
      "receiveOtherFinance",
      "\u6536\u5230\u7684\u5176\u4ED6\u4E0E\u7B79\u8D44\u6D3B\u52A8\u6709\u5173\u7684\u73B0\u91D1",
      "RECEIVE_OTHER_FINANCE"
    ],
    [
      "totalFinanceOutflow",
      "\u7B79\u8D44\u6D3B\u52A8\u73B0\u91D1\u6D41\u51FA\u5C0F\u8BA1",
      "TOTAL_FINANCE_OUTFLOW"
    ],
    [
      "payDebtCash",
      "\u507F\u8FD8\u503A\u52A1\u6240\u652F\u4ED8\u7684\u73B0\u91D1",
      "PAY_DEBT_CASH"
    ],
    [
      "assignDividendPorfit",
      "\u5206\u914D\u80A1\u5229\u3001\u5229\u6DA6\u6216\u507F\u4ED8\u5229\u606F\u652F\u4ED8\u7684\u73B0\u91D1",
      "ASSIGN_DIVIDEND_PORFIT"
    ],
    [
      "subsidiaryPayDividend",
      "\u5176\u4E2D:\u5B50\u516C\u53F8\u652F\u4ED8\u7ED9\u5C11\u6570\u80A1\u4E1C\u7684\u80A1\u5229\u3001\u5229\u6DA6",
      "SUBSIDIARY_PAY_DIVIDEND"
    ],
    [
      "payOtherFinance",
      "\u652F\u4ED8\u7684\u5176\u4ED6\u4E0E\u7B79\u8D44\u6D3B\u52A8\u6709\u5173\u7684\u73B0\u91D1",
      "PAY_OTHER_FINANCE"
    ],
    [
      "cceAdd",
      "\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u51C0\u589E\u52A0\u989D",
      "CCE_ADD",
      "\u73B0\u91D1\u51C0\u989D",
      "\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u589E\u52A0(\u51CF\u5C11)\u989D",
      "info"
    ],
    [
      "beginCce",
      "\u671F\u521D\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u4F59\u989D",
      "BEGIN_CCE",
      "\u671F\u521D\u73B0\u91D1",
      "\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u671F\u521D\u4F59\u989D"
    ],
    [
      "endCce",
      "\u671F\u672B\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u4F59\u989D",
      "END_CCE",
      "\u671F\u672B\u73B0\u91D1",
      "\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u671F\u672B\u4F59\u989D"
    ],
    [
      "rateChangeEffect",
      "\u6C47\u7387\u53D8\u52A8\u5BF9\u73B0\u91D1\u53CA\u73B0\u91D1\u7B49\u4EF7\u7269\u7684\u5F71\u54CD",
      "RATE_CHANGE_EFFECT",
      "",
      "\u6C47\u7387\u53D8\u52A8\u5F71\u54CD"
    ]
  ]
};

// src/shared/cache-policy.ts
var MINUTE_MS = 60 * 1e3;
var HOUR_MS = 60 * MINUTE_MS;
var DAY_MS = 24 * HOUR_MS;
var OPEN_MARKET_TTL_MS = 10 * MINUTE_MS;
var FINANCE_FALLBACK_TTL_MS = DAY_MS;
var MARKET_SCHEDULES = {
  cn: {
    timeZone: "Asia/Shanghai",
    sessions: [
      { startMinutes: 9 * 60 + 30, endMinutes: 11 * 60 + 30 },
      { startMinutes: 13 * 60, endMinutes: 15 * 60 }
    ]
  },
  hk: {
    timeZone: "Asia/Hong_Kong",
    sessions: [
      { startMinutes: 9 * 60 + 30, endMinutes: 12 * 60 },
      { startMinutes: 13 * 60, endMinutes: 16 * 60 }
    ]
  },
  us: {
    timeZone: "America/New_York",
    sessions: [{ startMinutes: 9 * 60 + 30, endMinutes: 16 * 60 }]
  }
};
var zonedPartsFormatterCache = /* @__PURE__ */ new Map();
function marketDataCacheTtlMsForCode(code, now = Date.now()) {
  const region = marketRegionForCode(code);
  return region ? marketDataCacheTtlMsForRegion(region, now) : 6 * HOUR_MS;
}
function marketDataCacheTtlMsForRegion(region, now = Date.now()) {
  const schedule = MARKET_SCHEDULES[region];
  const current = zonedDateParts(new Date(now), schedule.timeZone);
  const minutes = current.hour * 60 + current.minute;
  for (const session of schedule.sessions) {
    if (minutes >= session.startMinutes && minutes < session.endMinutes && isBusinessDay(current.weekday)) {
      return OPEN_MARKET_TTL_MS;
    }
  }
  const nextOpenAt = nextSessionOpenUtcMs(region, now);
  return Math.max(MINUTE_MS, nextOpenAt - now);
}
function marketDataCacheExpiresAtMsForCode(code, now = Date.now()) {
  return now + marketDataCacheTtlMsForCode(code, now);
}
function financialStatementsCacheTtlMs(rows, now = Date.now()) {
  if (hasLatestCompletedQuarter(rows, now)) {
    return Math.max(MINUTE_MS, currentQuarterEndUtcMs(now, "Asia/Shanghai") - now);
  }
  return FINANCE_FALLBACK_TTL_MS;
}
function areFinancialStatementsFresh(rows, now = Date.now()) {
  if (rows.length === 0) {
    return false;
  }
  if (hasLatestCompletedQuarter(rows, now)) {
    return now < currentQuarterEndUtcMs(now, "Asia/Shanghai");
  }
  const updatedAt = Number(rows[0]?.updatedAt ?? 0);
  return updatedAt > 0 && now - updatedAt < FINANCE_FALLBACK_TTL_MS;
}
function hasLatestCompletedQuarter(rows, now = Date.now()) {
  const latestReportDate = String(rows[0]?.reportDate ?? "").slice(0, 10);
  return latestReportDate === latestCompletedQuarterEndDate(now);
}
function latestCompletedQuarterEndDate(now = Date.now()) {
  return previousQuarterEndDate(now, "Asia/Shanghai");
}
function marketRegionForCode(code) {
  const suffix = securitySuffix(normalizeSecurityCode(code));
  if (suffix === "SH" || suffix === "SZ" || suffix === "BJ" || suffix === "OF") {
    return "cn";
  }
  if (suffix === "HK") {
    return "hk";
  }
  if (suffix === "US") {
    return "us";
  }
  return null;
}
function nextSessionOpenUtcMs(region, now) {
  const schedule = MARKET_SCHEDULES[region];
  const current = zonedDateParts(new Date(now), schedule.timeZone);
  const currentDateUtc = Date.UTC(current.year, current.month - 1, current.day);
  const currentMinutes = current.hour * 60 + current.minute;
  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    const candidateDate = new Date(currentDateUtc + dayOffset * DAY_MS);
    const weekday = candidateDate.getUTCDay();
    if (!isBusinessDay(weekday)) {
      continue;
    }
    for (const session of schedule.sessions) {
      if (dayOffset === 0 && session.startMinutes <= currentMinutes) {
        continue;
      }
      const hours = Math.floor(session.startMinutes / 60);
      const minutes = session.startMinutes % 60;
      return zonedDateTimeToUtcMs(
        schedule.timeZone,
        candidateDate.getUTCFullYear(),
        candidateDate.getUTCMonth() + 1,
        candidateDate.getUTCDate(),
        hours,
        minutes
      );
    }
  }
  return now + DAY_MS;
}
function currentQuarterEndUtcMs(now, timeZone) {
  const current = zonedDateParts(new Date(now), timeZone);
  const quarterIndex2 = Math.floor((current.month - 1) / 3);
  const nextQuarterMonth = quarterIndex2 * 3 + 4;
  let year = current.year;
  let month = nextQuarterMonth;
  if (month > 12) {
    month -= 12;
    year += 1;
  }
  return zonedDateTimeToUtcMs(timeZone, year, month, 1, 0, 0);
}
function previousQuarterEndDate(now, timeZone) {
  const current = zonedDateParts(new Date(now), timeZone);
  const quarterIndex2 = Math.floor((current.month - 1) / 3);
  if (quarterIndex2 === 0) {
    return `${current.year - 1}-12-31`;
  }
  const previousQuarterMonth = quarterIndex2 * 3;
  const lastDay = new Date(Date.UTC(current.year, previousQuarterMonth, 0)).getUTCDate();
  return `${current.year}-${pad2(previousQuarterMonth)}-${pad2(lastDay)}`;
}
function zonedDateTimeToUtcMs(timeZone, year, month, day, hour, minute) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = timeZoneOffsetMs(new Date(guess), timeZone);
    const adjusted = targetUtc - offset;
    if (adjusted === guess) {
      return adjusted;
    }
    guess = adjusted;
  }
  return guess;
}
function timeZoneOffsetMs(date, timeZone) {
  const parts = zonedDateParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
  return asUtc - date.getTime();
}
function zonedDateParts(date, timeZone) {
  let formatter = zonedPartsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    zonedPartsFormatterCache.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const values2 = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values2.get("year") ?? 0),
    month: Number(values2.get("month") ?? 0),
    day: Number(values2.get("day") ?? 0),
    weekday: weekdayToNumber(values2.get("weekday") ?? ""),
    hour: Number(values2.get("hour") ?? 0),
    minute: Number(values2.get("minute") ?? 0),
    second: Number(values2.get("second") ?? 0)
  };
}
function weekdayToNumber(value) {
  switch (value) {
    case "Sun":
      return 0;
    case "Mon":
      return 1;
    case "Tue":
      return 2;
    case "Wed":
      return 3;
    case "Thu":
      return 4;
    case "Fri":
      return 5;
    case "Sat":
      return 6;
    default:
      return -1;
  }
}
function isBusinessDay(weekday) {
  return weekday >= 1 && weekday <= 5;
}
function pad2(value) {
  return String(value).padStart(2, "0");
}

// src/adapters/eastmoney.ts
var bankCodeSet = new Set((finance_mappings_default.bankCodes ?? []).map((code) => normalizeSecurityCode(code)));
var securityCodeSet = new Set((finance_mappings_default.securityCodes ?? []).map((code) => normalizeSecurityCode(code)));
var insuranceCodeSet = new Set((finance_mappings_default.insuranceCodes ?? []).map((code) => normalizeSecurityCode(code)));
var PROVISIONAL_FINANCE_SOURCE_TTL_MS = 10 * 60 * 1e3;
var EASTMONEY_SUGGEST_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";
async function fetchEastmoneySuggest(db, q) {
  const url = new URL("https://searchadapter.eastmoney.com/api/suggest/get");
  url.searchParams.set("input", q);
  url.searchParams.set("type", "8");
  url.searchParams.set("token", EASTMONEY_SUGGEST_TOKEN);
  url.searchParams.set("count", "10");
  const body = await cachedFetchJson(db, url.toString(), {
    headers: { Referer: "https://www.eastmoney.com/" }
  }, 7 * 24 * 60 * 60 * 1e3);
  const now = Date.now();
  const records = [];
  for (const item of body.GubaCodeTable?.Data ?? []) {
    const rawCode = item.OuterCode?.trim() ?? "";
    const normalized = normalizeEastmoneySuggestCode(rawCode);
    const name = item.ShortName?.trim() ?? "";
    if (!normalized || !name || !isSupportedSecurityCode(normalized)) {
      continue;
    }
    records.push({
      code: normalized,
      market: securityMarket(normalized),
      type: inferSecurityType(normalized),
      name,
      source: "eastmoney",
      updatedAt: now
    });
  }
  return records;
}
function normalizeEastmoneySuggestCode(rawCode) {
  const code = rawCode.trim();
  const lowered = code.toLowerCase();
  if (lowered.startsWith("us") && code.length > 2) {
    return `${code.slice(2).toUpperCase()}.US`;
  }
  if (lowered.startsWith("hk") && code.length > 2) {
    return normalizeSecurityCode(code.slice(2));
  }
  if ((lowered.startsWith("sh") || lowered.startsWith("sz") || lowered.startsWith("bj")) && code.length > 2) {
    return normalizeSecurityCode(code.slice(2));
  }
  if (lowered.startsWith("of") && code.length > 2) {
    return `${code.slice(2).toUpperCase()}.OF`;
  }
  return normalizeSecurityCode(code);
}
async function fetchEastmoneyFundNav(db, code, from, to, pageSize = 120) {
  const normalized = normalizeSecurityCode(code).endsWith(".OF") ? normalizeSecurityCode(code) : `${bareCode(code)}.OF`;
  const now = Date.now();
  const rows = [];
  let receivedCount = 0;
  let pageIndex = 1;
  while (true) {
    const url = new URL("https://api.fund.eastmoney.com/f10/lsjz");
    url.searchParams.set("callback", "jQuery");
    url.searchParams.set("fundCode", bareCode(normalized));
    url.searchParams.set("pageIndex", String(pageIndex));
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("startDate", from);
    url.searchParams.set("endDate", to);
    url.searchParams.set("_", String(now));
    const body = await cachedFetchJson(db, url.toString(), {
      headers: { Referer: "https://fundf10.eastmoney.com/" }
    }, marketDataCacheTtlMsForCode(normalized));
    if (body.ErrCode && body.ErrCode !== 0) {
      throw new Error(`eastmoney fund nav error: code=${body.ErrCode} msg=${body.ErrMsg ?? ""}`);
    }
    const rawPageRows = body.Data?.LSJZList ?? [];
    const pageRows = rawPageRows.map((item) => ({
      code: normalized,
      date: item.FSRQ ?? "",
      nav: numberOrNull(item.DWJZ),
      accumNav: numberOrNull(item.LJJZ),
      dailyReturn: numberOrNull(item.JZZZL),
      subscriptionStatus: item.SGZT ?? null,
      redemptionStatus: item.SHZT ?? null,
      updatedAt: now
    })).filter((row) => row.date);
    rows.push(...pageRows);
    receivedCount += rawPageRows.length;
    const totalCount = Number.isInteger(body.TotalCount) && (body.TotalCount ?? 0) >= 0 ? body.TotalCount : void 0;
    const effectivePageSize = Number.isInteger(body.PageSize) && (body.PageSize ?? 0) > 0 ? body.PageSize : pageSize;
    if (rawPageRows.length === 0 || totalCount !== void 0 && receivedCount >= totalCount || totalCount === void 0 && rawPageRows.length < effectivePageSize) {
      break;
    }
    pageIndex += 1;
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}
async function fetchEastmoneyFinance(db, code, statementType, httpOptions) {
  const normalized = normalizeSecurityCode(code);
  if (!/\.(SH|SZ|BJ)$/.test(normalized)) {
    throw new Error(`finance statement only supports CN A-share codes in the MVP: ${code}`);
  }
  const reportType = eastmoneyFinanceReportType(statementType, normalized);
  const [quarterizedRows, annualIncomeRows] = await Promise.all([
    fetchEastmoneyFinanceRows(db, normalized, statementType, reportType, httpOptions),
    statementType === "income" ? fetchEastmoneyFinanceRows(db, normalized, statementType, eastmoneyAnnualIncomeReportType(normalized), httpOptions) : Promise.resolve([])
  ]);
  const annualRows = annualIncomeRows.filter((row) => isEastmoneyAnnualIncomeRow(row.payload)).map((row) => ({
    ...row,
    fiscalPeriod: "12M",
    payload: {
      ...row.payload,
      FISCAL_PERIOD: "12M",
      FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_annual_income.v1"
    }
  }));
  return [...quarterizedRows, ...annualRows];
}
async function fetchEastmoneyFinanceRows(db, normalized, statementType, reportType, httpOptions) {
  const url = new URL("https://datacenter-web.eastmoney.com/securities/api/data/get");
  url.searchParams.set("type", `RPT_F10_FINANCE_${reportType}`);
  url.searchParams.set("sty", financeStyle(statementType, reportType));
  url.searchParams.set(
    "filter",
    `(SECUCODE="${normalized}")(REPORT_DATE in ('${genReportDates(5).join("','")}'))`
  );
  url.searchParams.set("p", "1");
  url.searchParams.set("ps", "");
  url.searchParams.set("sr", "-1");
  url.searchParams.set("st", "REPORT_DATE");
  url.searchParams.set("source", "HSF10");
  url.searchParams.set("client", "PC");
  const body = await cachedFetchJson(db, url.toString(), {
    headers: { Referer: "https://emweb.securities.eastmoney.com/" }
  }, 24 * 60 * 60 * 1e3, {
    ...httpOptions,
    resolveCacheTtlMs: ({ text: text6 }) => ttlForEastmoneyFinancialResponse(text6)
  });
  const now = Date.now();
  const statements = [];
  for (const row of body.result?.data ?? []) {
    const reportDate = trimDate(row.REPORT_DATE);
    if (!reportDate) {
      continue;
    }
    statements.push({
      code: normalized,
      statementType,
      reportDate,
      fiscalPeriod: typeof row.REPORT_TYPE === "string" ? row.REPORT_TYPE : null,
      payload: row,
      source: "eastmoney",
      rawR2Key: null,
      updatedAt: now
    });
  }
  return statements;
}
function isEastmoneyAnnualIncomeRow(payload2) {
  if (!payload2 || typeof payload2 !== "object") return false;
  const reportType = String(payload2.REPORT_TYPE ?? "").trim().toUpperCase();
  return reportType === "\u5E74\u62A5" || reportType === "ANNUAL" || reportType === "FY" || reportType === "12M";
}
async function fetchEastmoneyHongKongFinance(db, code, statementType, httpOptions) {
  const normalized = normalizeSecurityCode(code);
  if (!/^\d{5}\.HK$/.test(normalized)) throw new Error(`Hong Kong finance requires an .HK company code: ${code}`);
  const url = new URL("https://datacenter.eastmoney.com/securities/api/data/v1/get");
  url.searchParams.set("reportName", "RPT_HKF10_FN_MAININDICATOR");
  url.searchParams.set("columns", "ALL");
  url.searchParams.set("filter", `(SECUCODE="${normalized}")`);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", "40");
  url.searchParams.set("sortColumns", "REPORT_DATE");
  url.searchParams.set("sortTypes", "-1");
  url.searchParams.set("source", "F10");
  url.searchParams.set("client", "PC");
  const [body, incomeSummary] = await Promise.all([
    cachedFetchJson(db, url.toString(), {
      headers: { Referer: "https://emweb.securities.eastmoney.com/PC_HKF10/pages/home/index.html" }
    }, 24 * 60 * 60 * 1e3, {
      ...httpOptions,
      resolveCacheTtlMs: ({ text: text6 }) => ttlForEastmoneyFinancialResponse(text6)
    }),
    fetchEastmoneyHongKongIncomeSummary(db, normalized, httpOptions)
  ]);
  const reportingMetadata = /* @__PURE__ */ new Map();
  const summaryRow = incomeSummary.result?.data?.[0] ?? {};
  const reports = Array.isArray(summaryRow.REPORT_LIST) ? summaryRow.REPORT_LIST : [];
  for (const report of reports) {
    const reportDate = trimDate(report.REPORT_DATE);
    if (!reportDate) continue;
    reportingMetadata.set(reportDate, {
      currency: typeof report.CURRENCY === "string" && report.CURRENCY.trim() ? report.CURRENCY.trim() : null,
      accountingStandard: typeof report.ACCOUNT_STANDARD === "string" && report.ACCOUNT_STANDARD.trim() ? report.ACCOUNT_STANDARD.trim() : null,
      reportType: typeof report.REPORT_TYPE === "string" && report.REPORT_TYPE.trim() ? report.REPORT_TYPE.trim() : null
    });
  }
  const now = Date.now();
  return (body.result?.data ?? []).flatMap((row) => {
    const reportDate = trimDate(row.REPORT_DATE);
    if (!reportDate) return [];
    const meta = reportingMetadata.get(reportDate);
    return [{
      code: normalized,
      statementType,
      reportDate,
      fiscalPeriod: meta?.reportType ?? (typeof row.REPORT_TYPE === "string" ? row.REPORT_TYPE : null),
      payload: {
        ...normalizeEastmoneyHongKongFinancePayload(row),
        REPORTING_CURRENCY: meta?.currency,
        REPORTING_ACCOUNT_STANDARD: meta?.accountingStandard,
        FINANCIAL_SOURCE_CONTRACT: "eastmoney_hk_f10_main_indicator.v2"
      },
      source: "eastmoney",
      rawR2Key: null,
      updatedAt: now
    }];
  });
}
function normalizeEastmoneyHongKongFinancePayload(row) {
  const aliases = {
    TOTAL_OPERATE_INCOME: "OPERATE_INCOME",
    PARENT_NETPROFIT: "HOLDER_PROFIT",
    END_CCE: "END_CASH"
  };
  const payload2 = { ...row };
  const origins = {};
  for (const [canonicalField, sourceField] of Object.entries(aliases)) {
    if (typeof row[sourceField] === "number" && Number.isFinite(row[sourceField])) {
      payload2[canonicalField] = row[sourceField];
      origins[canonicalField] = sourceField;
    }
  }
  if (Object.keys(origins).length > 0) {
    payload2.FINANCIAL_FIELD_ORIGINS = origins;
  }
  return payload2;
}
async function fetchEastmoneyHongKongIncomeSummary(db, code, httpOptions) {
  const url = new URL("https://datacenter.eastmoney.com/securities/api/data/v1/get");
  url.searchParams.set("reportName", "RPT_CUSTOM_HKF10_APPFN_INCOME_SUMMARY");
  url.searchParams.set("columns", "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,START_DATE,REPORT_DATE,FISCAL_YEAR,CURRENCY,ACCOUNT_STANDARD,REPORT_TYPE");
  url.searchParams.set("filter", `(SECUCODE="${code}")`);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("source", "F10");
  url.searchParams.set("client", "PC");
  return cachedFetchJson(db, url.toString(), {
    headers: { Referer: "https://emweb.securities.eastmoney.com/PC_HKF10/pages/home/index.html" }
  }, 24 * 60 * 60 * 1e3, {
    ...httpOptions,
    resolveCacheTtlMs: ({ text: text6 }) => ttlForEastmoneyFinancialResponse(text6)
  });
}
async function fetchYahooFinance(db, code, statementType, httpOptions) {
  const normalized = normalizeSecurityCode(code);
  const symbol = yahooChartSymbol(normalized);
  const url = new URL(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`);
  url.searchParams.set("type", yahooFinanceTypes().join(","));
  url.searchParams.set("period1", "0");
  url.searchParams.set("period2", String(yahooStablePeriod2()));
  const body = await cachedFetchJson(db, url.toString(), {
    headers: yahooFinanceHeaders(symbol)
  }, 24 * 60 * 60 * 1e3, {
    ...httpOptions,
    resolveCacheTtlMs: ({ text: text6 }) => ttlForYahooFinancialResponse(text6)
  });
  const error = body.timeseries?.error;
  if (error) {
    throw new Error(`yahoo finance error: code=${error.code ?? ""} description=${error.description ?? ""}`);
  }
  const rowsByPeriod = /* @__PURE__ */ new Map();
  for (const result of body.timeseries?.result ?? []) {
    const type = result.meta?.type?.[0];
    if (!type) {
      continue;
    }
    const key = yahooFinancePayloadKey(type);
    if (!key) {
      continue;
    }
    const points = Array.isArray(result[type]) ? result[type] : [];
    for (const point of points) {
      const reportDate = trimDate(point.asOfDate);
      if (!reportDate) {
        continue;
      }
      const periodType = yahooPeriodType(point, type);
      const rowKey = `${reportDate}:${periodType}`;
      const row = rowsByPeriod.get(rowKey) ?? {
        reportDate,
        noticeDate: reportDate,
        REPORT_DATE: reportDate,
        NOTICE_DATE: reportDate,
        FISCAL_PERIOD: periodType,
        YAHOO_PERIOD_TYPE: periodType,
        FINANCIAL_SOURCE_CONTRACT: "yahoo_finance_timeseries.v3",
        YAHOO_FIELD_CURRENCIES: {},
        YAHOO_FIELD_DATA_IDS: {}
      };
      row[key] = numberOrNull(point.reportedValue?.raw);
      const currencies = row.YAHOO_FIELD_CURRENCIES;
      const currency = yahooCurrency(point.currencyCode);
      if (currency) currencies[key] = currency;
      const dataIds = row.YAHOO_FIELD_DATA_IDS;
      if (typeof point.dataId === "string" && point.dataId.trim()) dataIds[key] = point.dataId.trim();
      rowsByPeriod.set(rowKey, row);
    }
  }
  const now = Date.now();
  return [...rowsByPeriod.values()].map(finalizeYahooFinancePayload).map((payload2) => normalizeYahooFinancePayload(payload2, statementType)).filter((payload2) => Object.keys(payload2).length > 4).sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate)) || String(b.FISCAL_PERIOD).localeCompare(String(a.FISCAL_PERIOD))).map((payload2) => ({
    code: normalized,
    statementType,
    reportDate: String(payload2.reportDate),
    fiscalPeriod: String(payload2.FISCAL_PERIOD ?? ""),
    payload: payload2,
    source: "yahoo",
    rawR2Key: null,
    updatedAt: now
  }));
}
function ttlForEastmoneyFinancialResponse(text6) {
  try {
    const body = parseJsonOrJsonp(text6);
    const rows = (body.result?.data ?? []).map((row) => ({ reportDate: trimDate(row.REPORT_DATE) })).filter((row) => row.reportDate);
    return financialStatementsCacheTtlMs(rows);
  } catch {
    return 24 * 60 * 60 * 1e3;
  }
}
function ttlForYahooFinancialResponse(text6) {
  try {
    const body = parseJsonOrJsonp(text6);
    const reportDates = /* @__PURE__ */ new Set();
    for (const result of body.timeseries?.result ?? []) {
      for (const value of Object.values(result)) {
        if (!Array.isArray(value)) {
          continue;
        }
        for (const point of value) {
          const reportDate = trimDate(point?.asOfDate);
          if (reportDate) {
            reportDates.add(reportDate);
          }
        }
      }
    }
    return financialStatementsCacheTtlMs([...reportDates].sort().reverse().map((reportDate) => ({ reportDate })));
  } catch {
    return 24 * 60 * 60 * 1e3;
  }
}
function yahooChartSymbol(code) {
  if (code.endsWith(".US")) {
    return code.slice(0, -3);
  }
  const hkMatch = code.match(/^0(\d{4})\.HK$/);
  if (hkMatch) {
    return `${hkMatch[1]}.HK`;
  }
  return code;
}
function yahooFinanceHeaders(symbol) {
  return {
    Accept: "application/json, text/plain, */*",
    Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/financials/`,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
  };
}
function eastmoneyFinanceReportType(statementType, code) {
  const normalized = normalizeSecurityCode(code);
  const family = bankCodeSet.has(normalized) ? "B" : securityCodeSet.has(normalized) ? "S" : insuranceCodeSet.has(normalized) ? "I" : "G";
  switch (statementType) {
    case "income":
      return `${family}INCOMEQC`;
    case "balance":
      return `${family}BALANCE`;
    case "cashflow":
      return family === "I" ? "ICASHFLOWQC" : `${family}CASHFLOW`;
  }
}
function eastmoneyAnnualIncomeReportType(code) {
  const quarterized = eastmoneyFinanceReportType("income", code);
  if (!quarterized.endsWith("INCOMEQC")) {
    throw new Error(`unexpected Eastmoney quarterized income report type: ${quarterized}`);
  }
  return quarterized.slice(0, -2);
}
function financeStyle(statementType, reportType) {
  if (statementType === "balance") {
    return `F10_FINANCE_${reportType}`;
  }
  return `APP_F10_${reportType}`;
}
function yahooFinanceTypes() {
  const metrics = [
    "TotalRevenue",
    "CostOfRevenue",
    "GrossProfit",
    "OperatingIncome",
    "NetIncome",
    "BasicEPS",
    "DilutedEPS",
    "TotalAssets",
    "TotalLiabilitiesNetMinorityInterest",
    "StockholdersEquity",
    "OperatingCashFlow",
    "FreeCashFlow",
    "EndCashPosition"
  ];
  return metrics.flatMap((metric) => [`quarterly${metric}`, `annual${metric}`]);
}
function yahooStablePeriod2() {
  const now = /* @__PURE__ */ new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2) / 1e3);
}
function yahooFinancePayloadKey(type) {
  const prefix = type.startsWith("quarterly") ? "quarterly" : type.startsWith("annual") ? "annual" : "";
  if (!prefix) return null;
  const metric = type.slice(prefix.length);
  const map = {
    TotalRevenue: "totalOperateIncome",
    CostOfRevenue: "operateCost",
    GrossProfit: "grossProfit",
    OperatingIncome: "operateProfit",
    NetIncome: "netProfit",
    BasicEPS: "basicEps",
    DilutedEPS: "dilutedEps",
    TotalAssets: "totaAssets",
    TotalLiabilitiesNetMinorityInterest: "totalLiabilities",
    StockholdersEquity: "totalEquity",
    OperatingCashFlow: "netcashOperate",
    FreeCashFlow: "freeCashFlow",
    EndCashPosition: "endCce"
  };
  return map[metric] ?? null;
}
function yahooPeriodType(point, type) {
  if (String(point.periodType ?? "").toUpperCase() === "12M" || type.startsWith("annual")) return "12M";
  return "3M";
}
function yahooCurrency(value) {
  const currency = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}
function finalizeYahooFinancePayload(payload2) {
  const fieldCurrencies = payload2.YAHOO_FIELD_CURRENCIES && typeof payload2.YAHOO_FIELD_CURRENCIES === "object" ? Object.values(payload2.YAHOO_FIELD_CURRENCIES).filter((value) => typeof value === "string" && value.length > 0) : [];
  const currencies = [...new Set(fieldCurrencies)];
  if (currencies.length === 1) return { ...payload2, REPORTING_CURRENCY: currencies[0] };
  if (currencies.length > 1) return { ...payload2, YAHOO_CURRENCY_CONFLICT: true };
  return payload2;
}
function normalizeYahooFinancePayload(payload2, statementType) {
  const row = { ...payload2 };
  const periodPrefix = row.FISCAL_PERIOD === "12M" ? "annual" : "quarterly";
  const aliases = {
    TOTAL_OPERATE_INCOME: { sourceField: "totalOperateIncome", yahooMetric: "TotalRevenue" },
    OPERATE_COST: { sourceField: "operateCost", yahooMetric: "CostOfRevenue" },
    GROSS_PROFIT: { sourceField: "grossProfit", yahooMetric: "GrossProfit" },
    OPERATE_PROFIT: { sourceField: "operateProfit", yahooMetric: "OperatingIncome" },
    NETPROFIT: { sourceField: "netProfit", yahooMetric: "NetIncome" },
    PARENT_NETPROFIT: { sourceField: "netProfit", yahooMetric: "NetIncome" },
    BASIC_EPS: { sourceField: "basicEps", yahooMetric: "BasicEPS" },
    DILUTED_EPS: { sourceField: "dilutedEps", yahooMetric: "DilutedEPS" },
    TOTAL_ASSETS: { sourceField: "totaAssets", yahooMetric: "TotalAssets" },
    TOTAL_LIABILITIES: { sourceField: "totalLiabilities", yahooMetric: "TotalLiabilitiesNetMinorityInterest" },
    TOTAL_EQUITY: { sourceField: "totalEquity", yahooMetric: "StockholdersEquity" },
    NETCASH_OPERATE: { sourceField: "netcashOperate", yahooMetric: "OperatingCashFlow" },
    FREE_CASH_FLOW: { sourceField: "freeCashFlow", yahooMetric: "FreeCashFlow" },
    END_CCE: { sourceField: "endCce", yahooMetric: "EndCashPosition" }
  };
  const origins = {};
  for (const [canonicalField, { sourceField, yahooMetric }] of Object.entries(aliases)) {
    if (typeof row[sourceField] === "number" && Number.isFinite(row[sourceField])) {
      row[canonicalField] = row[sourceField];
      origins[canonicalField] = `${periodPrefix}${yahooMetric}`;
    }
  }
  if (Object.keys(origins).length > 0) row.FINANCIAL_FIELD_ORIGINS = origins;
  if (statementType === "income") {
    row.operateIncome = row.totalOperateIncome;
    row.totalOperateCost = row.operateCost;
    row.parentNetprofit = row.netProfit;
  }
  if (statementType === "balance") {
    row.totalAssets = row.totaAssets;
  }
  return row;
}
function genReportDates(years) {
  const now = /* @__PURE__ */ new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const dates2 = [];
  for (let i = 0; i < years; i += 1) {
    const current = year - i;
    if (i > 0) {
      dates2.push(`${current}-12-31`);
    }
    if (i !== 0 || month > 9) {
      dates2.push(`${current}-09-30`);
    }
    if (i !== 0 || month > 6) {
      dates2.push(`${current}-06-30`);
    }
    if (i !== 0 || month > 3) {
      dates2.push(`${current}-03-31`);
    }
  }
  return dates2;
}
function trimDate(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.slice(0, 10);
}

// src/storage/market-data.ts
var KLINE_HISTORY_START = "1990-01-01";
function klineSnapshotKey(code, fq) {
  return `kline/${fq}/${code}.json`;
}
function fundNavSnapshotKey(code) {
  return `fund-nav/${code}.json`;
}
function financialStatementsSnapshotKey(code, statementType) {
  return `financial-statements/${statementType}/${code}.json`;
}
function fullKlineHistoryStartDate() {
  return KLINE_HISTORY_START;
}
async function getKlineSnapshot(env, code, fq) {
  const object3 = await env.MARKET_DATA_BUCKET.get(klineSnapshotKey(code, fq));
  if (!object3) {
    return null;
  }
  return await object3.json();
}
async function putKlineSnapshot(env, code, fq, rows, options) {
  const snapshot = {
    schemaVersion: 2,
    code,
    fq,
    source: rows[0]?.source ?? "xueqiu",
    updatedAt: rows[0]?.updatedAt ?? Date.now(),
    startDate: rows[0]?.date ?? null,
    endDate: rows.at(-1)?.date ?? null,
    rows,
    ...options?.rawResponseText !== void 0 ? { rawResponseText: options.rawResponseText } : {}
  };
  await env.MARKET_DATA_BUCKET.put(klineSnapshotKey(code, fq), JSON.stringify(snapshot), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8"
    }
  });
}
function sliceKlineRows(rows, from, to) {
  return rows.filter((row) => row.date >= from && row.date <= to);
}
async function getFundNavSnapshot(env, code) {
  const object3 = await env.MARKET_DATA_BUCKET.get(fundNavSnapshotKey(code));
  if (!object3) {
    return null;
  }
  return await object3.json();
}
function sliceFundNavRows(rows, from, to) {
  return rows.filter((row) => row.date >= from && row.date <= to);
}
async function getFinancialStatementsSnapshot(env, code, statementType) {
  const object3 = await env.MARKET_DATA_BUCKET.get(financialStatementsSnapshotKey(code, statementType));
  if (!object3) {
    return null;
  }
  return await object3.json();
}
async function putFinancialStatementsSnapshot(env, code, statementType, rows, options) {
  const updatedAt = rows[0]?.updatedAt ?? options?.provisionalData?.updatedAt ?? Date.now();
  const snapshot = {
    code,
    statementType,
    source: rows[0]?.source ?? "eastmoney",
    updatedAt,
    reportDates: rows.map((row) => row.reportDate),
    rows,
    ...options?.provisionalData ? { provisionalData: options.provisionalData } : {}
  };
  await env.MARKET_DATA_BUCKET.put(financialStatementsSnapshotKey(code, statementType), JSON.stringify(snapshot), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8"
    }
  });
}
function snapshotCoversRange(snapshot, from, to) {
  return Boolean(snapshot.startDate && snapshot.endDate && snapshot.startDate <= from && snapshot.endDate >= to);
}

// src/modules/finance/application/select-quarterly-income-statements.ts
var SOURCE_LABELS = {
  financial_report: "\u6B63\u5F0F\u8D22\u62A5",
  performance_report: "\u4E1A\u7EE9\u5FEB\u62A5",
  performance_forecast: "\u4E1A\u7EE9\u9884\u544A"
};
function selectQuarterlyIncomeStatements(formalRows, performanceRows, forecastRows, now = Date.now()) {
  const formalByDate = latestRowsByDate(formalRows);
  const performanceByDate = latestPayloadRowsByDate(performanceRows);
  const forecastByDate = latestForecastRowsByDate(forecastRows);
  const earliestYear = new Date(now).getUTCFullYear() - 4;
  const reportDates = /* @__PURE__ */ new Set([...formalByDate.keys(), ...performanceByDate.keys(), ...forecastByDate.keys()]);
  const accumulators = /* @__PURE__ */ new Map();
  const selected = [];
  for (const reportDate of [...reportDates].sort()) {
    const year = Number(reportDate.slice(0, 4));
    const quarter = quarterNumber(reportDate);
    if (!Number.isInteger(year) || year < earliestYear || quarter === null) {
      continue;
    }
    const accumulator = accumulators.get(year) ?? emptyAccumulator();
    const formal = formalByDate.get(reportDate);
    let row = null;
    if (formal) {
      row = markFormalStatement(formal);
    } else {
      const performance = performanceByDate.get(reportDate);
      if (performance) {
        row = provisionalStatement(
          formalRows[0]?.code ?? String(performance.SECUCODE ?? performance.SECURITY_CODE ?? ""),
          reportDate,
          performance,
          "performance_report",
          accumulator,
          quarter,
          now
        );
      } else {
        const forecast = forecastByDate.get(reportDate);
        if (forecast) {
          row = provisionalStatement(
            formalRows[0]?.code ?? String(forecast.SECUCODE ?? forecast.SECURITY_CODE ?? ""),
            reportDate,
            forecast,
            "performance_forecast",
            accumulator,
            quarter,
            now
          );
        }
      }
    }
    if (!row) {
      continue;
    }
    selected.push(row);
    advanceAccumulator(accumulator, row.payload, quarter);
    accumulators.set(year, accumulator);
  }
  return selected.sort((a, b) => b.reportDate.localeCompare(a.reportDate));
}
function mergeProvisionalFinancialStatements(existingRows, incomingPerformanceRows, incomingForecastRows, now = Date.now()) {
  const normalized = ensureFinancialSourceMetadata(existingRows);
  const formalRows = normalized.filter((row) => asRecord(row.payload).dataSource === "financial_report");
  const storedPerformanceRows = normalized.filter((row) => asRecord(row.payload).dataSource === "performance_report").map((row) => restoreCumulativePayload(row.payload));
  const storedForecastRows = normalized.filter((row) => asRecord(row.payload).dataSource === "performance_forecast").map((row) => asRecord(row.payload));
  return selectQuarterlyIncomeStatements(
    formalRows,
    [...storedPerformanceRows, ...incomingPerformanceRows],
    [...storedForecastRows, ...incomingForecastRows],
    now
  );
}
function ensureFinancialSourceMetadata(rows) {
  return rows.map((row) => {
    const payload2 = asRecord(row.payload);
    if (isFinancialDataSource(payload2.dataSource)) {
      if (payload2.dataSource !== "financial_report" && payload2.NETPROFIT == null && payload2.PARENT_NETPROFIT != null) {
        return { ...row, payload: { ...payload2, NETPROFIT: payload2.PARENT_NETPROFIT } };
      }
      return row;
    }
    return markFormalStatement(row);
  });
}
function isProvisionalFinancialStatement(row) {
  const source = asRecord(row?.payload).dataSource;
  return source === "performance_report" || source === "performance_forecast";
}
function markFormalStatement(row) {
  return {
    ...row,
    payload: withSource(asRecord(row.payload), "financial_report")
  };
}
function restoreCumulativePayload(value) {
  const payload2 = asRecord(value);
  return {
    ...payload2,
    TOTAL_OPERATE_INCOME: payload2.cumulativeTotalOperateIncome ?? payload2.TOTAL_OPERATE_INCOME,
    PARENT_NETPROFIT: payload2.cumulativeParentNetprofit ?? payload2.PARENT_NETPROFIT,
    BASIC_EPS: payload2.cumulativeBasicEps ?? payload2.BASIC_EPS
  };
}
function provisionalStatement(code, reportDate, raw2, source, accumulator, quarter, now) {
  const cumulativeRevenue = source === "performance_report" ? numberValue(raw2.TOTAL_OPERATE_INCOME) : numberValue(raw2.FORECAST_REVENUE_JZ);
  const cumulativeProfit = source === "performance_report" ? numberValue(raw2.PARENT_NETPROFIT) : numberValue(raw2.FORECAST_PROFIT_JZ);
  const cumulativeEps = source === "performance_report" ? numberValue(raw2.BASIC_EPS) : void 0;
  const revenue = quarterValue(cumulativeRevenue, accumulator.revenue, accumulator.revenueComplete, quarter);
  const profit = quarterValue(cumulativeProfit, accumulator.profit, accumulator.profitComplete, quarter);
  const eps = quarterValue(cumulativeEps, accumulator.eps, accumulator.epsComplete, quarter);
  if (revenue === void 0 && profit === void 0 && eps === void 0) {
    return null;
  }
  const payload2 = withSource({
    ...raw2,
    REPORT_DATE: reportDate,
    NOTICE_DATE: trimDate2(raw2.NOTICE_DATE) || reportDate,
    REPORT_TYPE: SOURCE_LABELS[source],
    TOTAL_OPERATE_INCOME: revenue ?? null,
    OPERATE_INCOME: revenue ?? null,
    PARENT_NETPROFIT: profit ?? null,
    NETPROFIT: profit ?? null,
    BASIC_EPS: eps ?? null,
    cumulativeTotalOperateIncome: cumulativeRevenue ?? null,
    cumulativeParentNetprofit: cumulativeProfit ?? null,
    cumulativeBasicEps: cumulativeEps ?? null
  }, source);
  return {
    code,
    statementType: "income",
    reportDate,
    fiscalPeriod: `${quarter * 3}M`,
    payload: payload2,
    source: source === "performance_report" ? "eastmoney_performance" : "eastmoney_forecast",
    rawR2Key: null,
    updatedAt: now
  };
}
function advanceAccumulator(accumulator, payloadValue, quarter) {
  const payload2 = asRecord(payloadValue);
  const sequential = quarter === 1 || accumulator.lastQuarter === quarter - 1;
  accumulator.revenueComplete = sequential && numberValue(payload2.TOTAL_OPERATE_INCOME) !== void 0 && (quarter === 1 || accumulator.revenueComplete);
  accumulator.profitComplete = sequential && numberValue(payload2.PARENT_NETPROFIT) !== void 0 && (quarter === 1 || accumulator.profitComplete);
  accumulator.epsComplete = sequential && numberValue(payload2.BASIC_EPS) !== void 0 && (quarter === 1 || accumulator.epsComplete);
  accumulator.revenue = accumulator.revenueComplete ? (quarter === 1 ? 0 : accumulator.revenue ?? 0) + numberValue(payload2.TOTAL_OPERATE_INCOME) : void 0;
  accumulator.profit = accumulator.profitComplete ? (quarter === 1 ? 0 : accumulator.profit ?? 0) + numberValue(payload2.PARENT_NETPROFIT) : void 0;
  accumulator.eps = accumulator.epsComplete ? (quarter === 1 ? 0 : accumulator.eps ?? 0) + numberValue(payload2.BASIC_EPS) : void 0;
  accumulator.lastQuarter = quarter;
}
function quarterValue(cumulative, previousCumulative, previousComplete, quarter) {
  if (cumulative === void 0) return void 0;
  if (quarter === 1) return cumulative;
  if (!previousComplete || previousCumulative === void 0) return void 0;
  return cumulative - previousCumulative;
}
function latestRowsByDate(rows) {
  const result = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (row.reportDate && !result.has(row.reportDate)) result.set(row.reportDate, row);
  }
  return result;
}
function latestPayloadRowsByDate(rows) {
  const result = /* @__PURE__ */ new Map();
  for (const row of [...rows].sort(compareNoticeDateDesc)) {
    const reportDate = trimDate2(row.REPORT_DATE);
    if (reportDate && !result.has(reportDate)) result.set(reportDate, row);
  }
  return result;
}
function latestForecastRowsByDate(rows) {
  const result = /* @__PURE__ */ new Map();
  for (const row of [...rows].sort(compareNoticeDateDesc)) {
    const reportDate = trimDate2(row.REPORT_DATE);
    if (reportDate && (row.FORECAST_PROFIT_JZ !== void 0 || row.FORECAST_REVENUE_JZ !== void 0)) {
      const current2 = result.get(reportDate) ?? {};
      result.set(reportDate, { ...current2, ...row });
      continue;
    }
    const financeCode = String(row.PREDICT_FINANCE_CODE ?? "");
    if (!reportDate || !["004", "006"].includes(financeCode) || String(row.IS_LATEST ?? "T") === "F") {
      continue;
    }
    const current = result.get(reportDate) ?? {
      SECUCODE: row.SECUCODE,
      SECURITY_CODE: row.SECURITY_CODE,
      REPORT_DATE: row.REPORT_DATE,
      NOTICE_DATE: row.NOTICE_DATE
    };
    if (financeCode === "004" && current.FORECAST_PROFIT_JZ === void 0) {
      Object.assign(current, row, { FORECAST_PROFIT_JZ: forecastAmount(row) });
    }
    if (financeCode === "006" && current.FORECAST_REVENUE_JZ === void 0) {
      current.FORECAST_REVENUE_JZ = forecastAmount(row);
    }
    result.set(reportDate, current);
  }
  return result;
}
function compareNoticeDateDesc(a, b) {
  return String(b.NOTICE_DATE ?? "").localeCompare(String(a.NOTICE_DATE ?? ""));
}
function forecastAmount(row) {
  const center = numberValue(row.FORECAST_JZ);
  if (center !== void 0) return center;
  const lower = numberValue(row.PREDICT_AMT_LOWER);
  const upper = numberValue(row.PREDICT_AMT_UPPER);
  if (lower !== void 0 && upper !== void 0) return (lower + upper) / 2;
  return lower ?? upper;
}
function withSource(payload2, source) {
  return { ...payload2, dataSource: source, dataSourceLabel: SOURCE_LABELS[source] };
}
function emptyAccumulator() {
  return { lastQuarter: 0, revenueComplete: false, profitComplete: false, epsComplete: false };
}
function quarterNumber(reportDate) {
  const month = Number(reportDate.slice(5, 7));
  if (month === 3) return 1;
  if (month === 6) return 2;
  if (month === 9) return 3;
  if (month === 12) return 4;
  return null;
}
function numberValue(value) {
  if (value === null || value === void 0 || value === "") return void 0;
  const result = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
  return Number.isFinite(result) ? result : void 0;
}
function trimDate2(value) {
  return typeof value === "string" ? value.slice(0, 10) : "";
}
function asRecord(value) {
  return value && typeof value === "object" ? value : {};
}
function isFinancialDataSource(value) {
  return value === "financial_report" || value === "performance_report" || value === "performance_forecast";
}

// src/modules/finance/domain/normalize-financial-statements.ts
var METRICS_BY_STATEMENT = {
  income: [
    ["revenue", ["TOTAL_OPERATE_INCOME", "OPERATE_INCOME", "totalOperateIncome", "operateIncome"]],
    ["costOfRevenue", ["OPERATE_COST", "TOTAL_OPERATE_COST", "operateCost", "totalOperateCost"]],
    ["grossProfit", ["GROSS_PROFIT", "grossProfit"]],
    ["operatingIncome", ["OPERATE_PROFIT", "operateProfit"]],
    ["netIncome", ["NETPROFIT", "netProfit"]],
    ["parentNetIncome", ["PARENT_NETPROFIT", "HOLDER_PROFIT"]],
    ["basicEps", ["BASIC_EPS", "basicEps"]],
    ["dilutedEps", ["DILUTED_EPS", "dilutedEps"]]
  ],
  balance: [
    ["totalAssets", ["TOTAL_ASSETS", "totalAssets", "totaAssets"]],
    ["totalLiabilities", ["TOTAL_LIABILITIES", "totalLiabilities"]],
    ["totalEquity", ["TOTAL_EQUITY", "totalEquity"]],
    ["cashAndCashEquivalents", ["MONETARYFUNDS", "END_CCE", "END_CASH", "endCce"]]
  ],
  cashflow: [
    ["operatingCashFlow", ["NETCASH_OPERATE", "netcashOperate"]],
    ["freeCashFlow", ["FREE_CASH_FLOW", "freeCashFlow"]],
    ["capitalExpenditure", ["CONSTRUCT_LONG_ASSET", "capitalExpenditure"]],
    ["cashAndCashEquivalents", ["END_CCE", "END_CASH", "endCce"]]
  ]
};
function normalizeFinancialStatement(row) {
  const payload2 = asRecord2(row.payload);
  const values2 = [];
  for (const [metric, candidates] of METRICS_BY_STATEMENT[row.statementType]) {
    const matched = firstFiniteNumber(payload2, candidates);
    if (matched) {
      values2.push({ metric, value: matched.value, sourceField: matched.sourceField });
    }
  }
  return {
    code: row.code,
    statementType: row.statementType,
    reportDate: row.reportDate,
    fiscalPeriod: row.fiscalPeriod,
    noticeDate: dateValue(payload2.NOTICE_DATE ?? payload2.noticeDate),
    source: row.source,
    updatedAt: row.updatedAt,
    currency: stringValue(payload2.CURRENCY ?? payload2.CURRENCY_TYPE ?? payload2.currency),
    values: values2
  };
}
function normalizeFinancialStatements(rows) {
  return rows.map(normalizeFinancialStatement);
}
function asRecord2(value) {
  return value && typeof value === "object" ? value : {};
}
function firstFiniteNumber(payload2, candidates) {
  for (const sourceField of candidates) {
    const value = payload2[sourceField];
    if (typeof value === "number" && Number.isFinite(value)) {
      return { value, sourceField };
    }
  }
  return null;
}
function dateValue(value) {
  return typeof value === "string" && value ? value.slice(0, 10) : null;
}
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// src/modules/finance/domain/financial-read-model.ts
function financialStatementSourcePolicy(code) {
  const normalized = code.trim().toUpperCase();
  if (/\.(SH|SZ|BJ)$/.test(normalized)) {
    return { market: "a_share", primaryProvider: "eastmoney", statutoryVerifier: "cninfo", automaticFallback: false, usTransport: null };
  }
  if (/^\d{5}\.HK$/.test(normalized)) {
    return { market: "h_share", primaryProvider: "eastmoney", statutoryVerifier: "hkex", automaticFallback: false, usTransport: null };
  }
  if (/\.US$/.test(normalized)) {
    return { market: "us_share", primaryProvider: "yahoo", statutoryVerifier: "sec", automaticFallback: false, usTransport: "local_proxy_or_production_direct" };
  }
  return { market: "unsupported", primaryProvider: null, statutoryVerifier: null, automaticFallback: false, usTransport: null };
}
function financialStatementFailure(error) {
  const message2 = error instanceof Error ? error.message : String(error);
  const normalized = message2.toLowerCase();
  if (/only supports|requires an \.hk|unsupported/.test(normalized)) return { reason: "unsupported_security", message: message2 };
  if (normalized.includes("http_proxy_relay_url is required")) return { reason: "missing_proxy_configuration", message: message2 };
  if (/status=429|rate limit|too many requests/.test(normalized)) return { reason: "provider_rate_limited", message: message2 };
  if (/timed out|timeout/.test(normalized)) return { reason: "provider_timeout", message: message2 };
  if (/invalid json|jsonp|unexpected token/.test(normalized)) return { reason: "invalid_provider_response", message: message2 };
  if (/request failed: status=|proxy relay request failed|yahoo finance error/.test(normalized)) return { reason: "provider_response_error", message: message2 };
  return { reason: "unexpected_error", message: message2 };
}
function buildFinancialStatementReadModel(input) {
  const rows = input.rows;
  const payloads = rows.map(payload);
  const latestReportDate = dates(rows.map((row) => row.reportDate))[0] ?? null;
  const currencies = values(payloads.map((item) => item.REPORTING_CURRENCY ?? item.CURRENCY));
  const accountingStandards = values(payloads.map((item) => item.REPORTING_ACCOUNT_STANDARD ?? item.ACCOUNT_STANDARD));
  const revisionStatuses = values(payloads.map((item) => item.REVISION ?? item.REVISION_STATUS)).map((item) => item.toLowerCase());
  const originProviders = values(rows.map((row) => row.source));
  const updatedAt = rows.map((row) => Number(row.updatedAt)).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? null;
  const unavailable = rows.length === 0;
  return {
    code: input.code,
    statementType: input.statementType,
    sourcePolicy: financialStatementSourcePolicy(input.code),
    delivery: unavailable ? null : {
      cache: input.source === "r2" ? "r2" : "provider",
      originProviders,
      updatedAt,
      freshness: input.fresh ? "fresh" : "stale"
    },
    reportingCurrencies: currencies,
    accountingStandards,
    periods: rows.map((row) => ({ reportDate: row.reportDate, fiscalPeriod: row.fiscalPeriod ?? stringOrNull(payload(row).FISCAL_PERIOD) })),
    latestReportDate,
    dataAsOf: latestReportDate,
    revisionStatuses: revisionStatuses.length ? revisionStatuses : ["not_supplied"],
    fieldAvailability: { rows: rows.length, nonEmptyPayloadRows: rows.filter((row) => Object.keys(payload(row)).length > 0).length, status: unavailable ? "unavailable" : "available" },
    sourceHealth: unavailable ? { status: "degraded", reason: "no_primary_data", message: "primary financial provider returned no statement rows" } : { status: "healthy", reason: null, message: null },
    rows,
    normalizedRows: normalizeFinancialStatements(rows)
  };
}
function failedFinancialStatementReadModel(code, statementType, error) {
  const failure = financialStatementFailure(error);
  return {
    code,
    statementType,
    sourcePolicy: financialStatementSourcePolicy(code),
    delivery: null,
    reportingCurrencies: [],
    accountingStandards: [],
    periods: [],
    latestReportDate: null,
    dataAsOf: null,
    revisionStatuses: [],
    fieldAvailability: { rows: 0, nonEmptyPayloadRows: 0, status: "unavailable" },
    sourceHealth: { status: "failed", ...failure },
    rows: [],
    normalizedRows: []
  };
}
function payload(row) {
  return row.payload && typeof row.payload === "object" ? row.payload : {};
}
function values(valuesToRead) {
  return [...new Set(valuesToRead.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean))];
}
function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function dates(valuesToRead) {
  return [...new Set(valuesToRead.filter(Boolean))].sort((left, right) => right.localeCompare(left));
}

// src/modules/finance/application/load-financial-statements.ts
var PROVISIONAL_FINANCE_TTL_MS = 30 * 60 * 1e3;
async function loadFinancialStatements(env, rawCode, statementType, options) {
  const code = normalizeSecurityCode(rawCode);
  const snapshot = await getFinancialStatementsSnapshot(env, code, statementType);
  const snapshotRows = snapshot ? ensureFinancialSourceMetadata(snapshot.rows) : [];
  const pendingProvisional = statementType === "income" ? snapshot?.provisionalData : void 0;
  const hongKongSnapshotNeedsSourceMetadata = isHongKongExchangeCode(code) && snapshotRows.length > 0 && snapshotRows.some((row) => !hasHongKongReportingMetadata(row));
  const usSnapshotNeedsSourceMetadata = isUsExchangeCode(code) && snapshotRows.length > 0 && snapshotRows.some((row) => !hasYahooReportingMetadata(row));
  const aShareIncomeSnapshotNeedsAnnualSource = isCnExchangeCode(code) && statementType === "income" && snapshotRows.length > 0 && !snapshotRows.some(isEastmoneyAnnualIncomeStatement);
  if (snapshotRows.length > 0 && !hongKongSnapshotNeedsSourceMetadata && !usSnapshotNeedsSourceMetadata && !aShareIncomeSnapshotNeedsAnnualSource) {
    const now = Date.now();
    const latest = snapshotRows[0];
    if (isProvisionalFinancialStatement(latest) && now - latest.updatedAt < PROVISIONAL_FINANCE_TTL_MS) {
      return { code, source: "r2", rows: snapshotRows };
    }
    const unresolvedPending = pendingProvisional ? !snapshotRows.some((row) => row.reportDate === pendingProvisional.reportDate) : false;
    if (!unresolvedPending && !isProvisionalFinancialStatement(latest) && areFinancialStatementsFresh(snapshotRows, now)) {
      return { code, source: "r2", rows: snapshotRows };
    }
  }
  if (isUsExchangeCode(code)) {
    const rows2 = ensureFinancialSourceMetadata(await fetchYahooFinance(env.DB, code, statementType, options?.httpOptions));
    if (rows2.length > 0) await putFinancialStatementsSnapshot(env, code, statementType, rows2);
    return { code, source: "yahoo", rows: rows2 };
  }
  if (isHongKongExchangeCode(code)) {
    const rows2 = ensureFinancialSourceMetadata(await fetchEastmoneyHongKongFinance(env.DB, code, statementType, options?.httpOptions));
    if (rows2.length > 0) await putFinancialStatementsSnapshot(env, code, statementType, rows2);
    return { code, source: "eastmoney", rows: rows2 };
  }
  if (!isCnExchangeCode(code)) {
    return { code, source: "eastmoney", rows: [] };
  }
  const formalRows = await fetchEastmoneyFinance(env.DB, code, statementType, options?.httpOptions);
  let rows = ensureFinancialSourceMetadata(formalRows);
  if (statementType === "income") {
    const annualRows = rows.filter(isEastmoneyAnnualIncomeStatement);
    const quarterizedRows = formalRows.filter((row) => !isEastmoneyAnnualIncomeStatement(row));
    const cachedQuarterizedRows = snapshotRows.filter((row) => !isEastmoneyAnnualIncomeStatement(row));
    rows = [...annualRows, ...mergeProvisionalFinancialStatements(
      [...quarterizedRows, ...cachedQuarterizedRows],
      pendingProvisional?.performanceRows ?? [],
      pendingProvisional?.forecastRows ?? []
    )].sort((left, right) => right.reportDate.localeCompare(left.reportDate) || Number(isEastmoneyAnnualIncomeStatement(right)) - Number(isEastmoneyAnnualIncomeStatement(left)));
  }
  if (rows.length > 0) {
    const latestFormalized = pendingProvisional ? rows.some((row) => row.reportDate === pendingProvisional.reportDate && !isProvisionalFinancialStatement(row)) : false;
    await putFinancialStatementsSnapshot(env, code, statementType, rows, {
      provisionalData: latestFormalized ? void 0 : pendingProvisional
    });
  }
  return { code, source: "eastmoney", rows };
}
async function loadFinancialStatementReadModel(env, rawCode, statementType, options) {
  const code = normalizeSecurityCode(rawCode);
  try {
    const result = await loadFinancialStatements(env, code, statementType, options);
    return buildFinancialStatementReadModel({
      ...result,
      statementType,
      fresh: result.source !== "r2" || areFinancialStatementsFresh(result.rows)
    });
  } catch (error) {
    return failedFinancialStatementReadModel(code, statementType, error);
  }
}
function isCnExchangeCode(code) {
  return /\.(SH|SZ|BJ)$/.test(normalizeSecurityCode(code));
}
function isUsExchangeCode(code) {
  return /\.US$/.test(normalizeSecurityCode(code));
}
function isHongKongExchangeCode(code) {
  return /^\d{5}\.HK$/.test(normalizeSecurityCode(code));
}
function hasHongKongReportingMetadata(row) {
  const payload2 = row.payload && typeof row.payload === "object" ? row.payload : {};
  return payload2.FINANCIAL_SOURCE_CONTRACT === "eastmoney_hk_f10_main_indicator.v2" && typeof payload2.REPORTING_CURRENCY === "string" && payload2.REPORTING_CURRENCY.trim().length > 0 && typeof payload2.REPORTING_ACCOUNT_STANDARD === "string" && payload2.REPORTING_ACCOUNT_STANDARD.trim().length > 0;
}
function hasYahooReportingMetadata(row) {
  const payload2 = row.payload && typeof row.payload === "object" ? row.payload : {};
  return payload2.FINANCIAL_SOURCE_CONTRACT === "yahoo_finance_timeseries.v3" && typeof payload2.REPORTING_CURRENCY === "string" && payload2.REPORTING_CURRENCY.trim().length > 0 && typeof payload2.FISCAL_PERIOD === "string" && payload2.FISCAL_PERIOD.trim().length > 0;
}
function isEastmoneyAnnualIncomeStatement(row) {
  if (row.statementType !== "income" || row.source !== "eastmoney") return false;
  const payload2 = row.payload && typeof row.payload === "object" ? row.payload : {};
  return payload2.FINANCIAL_SOURCE_CONTRACT === "eastmoney_f10_annual_income.v1" && payload2.FISCAL_PERIOD === "12M";
}

// src/modules/research/domain/research-identity.ts
var rejectedInstrumentTypes = /* @__PURE__ */ new Set([
  "etf",
  "fund",
  "index",
  "index_fund",
  "mutual_fund",
  "closed_end_fund",
  "open_end_fund"
]);
var equityInstrumentTypes = /* @__PURE__ */ new Set([
  "stock",
  "equity",
  "common_stock",
  "common_share",
  "ordinary_share",
  "h_share"
]);
var knownIndexCodes = /* @__PURE__ */ new Set(["SPX.US", "DJI.US", "IXIC.US"]);
function classifyResearchSecurity(input) {
  const code = normalizeSecurityCode(input.code);
  const type = normalizeToken(input.instrumentType);
  const name = String(input.name ?? "").trim();
  if (!code) throw new Error("security code is required");
  if (rejectedInstrumentTypes.has(type) || knownIndexCodes.has(code) || code.startsWith("^") || looksLikeFundOrIndex(name)) {
    throw new Error(`research identity only supports listed company equity securities: ${code}`);
  }
  let market;
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(code)) {
    if (/^[15]/.test(code)) {
      throw new Error(`research identity rejects mainland funds and ETFs: ${code}`);
    }
    market = "a_share";
  } else if (/^\d{5}\.HK$/.test(code)) {
    market = "h_share";
  } else if (/^[A-Z0-9.-]+\.US$/.test(code)) {
    market = "us_share";
  } else {
    throw new Error(`unsupported listed company security code: ${code}`);
  }
  const instrumentKind = type === "adr" || type === "depositary_receipt" ? "adr" : equityInstrumentTypes.has(type) ? "equity" : "unknown";
  return { code, market, instrumentKind, eligibility: instrumentKind === "unknown" ? "needs_review" : "eligible" };
}
function normalizeToken(value) {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/[ -]+/g, "_");
}
function looksLikeFundOrIndex(name) {
  if (!name) return false;
  return /ETF/i.test(name) || /交易型开放式指数证券投资基金|证券投资基金$|股票指数$/.test(name);
}

// src/modules/research/domain/research-financial-comparison-identity.ts
function canonicalFinancialComparisonKey(input) {
  const source = required2(input.source, "source");
  const securityCode = required2(input.securityCode, "securityCode").toUpperCase();
  const statementType = required2(input.statementType, "statementType");
  const metric = required2(input.metric, "metric");
  const period = input.period;
  const basis = input.basis;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(period.endDate) || period.startDate > period.endDate) {
    throw new Error("financial comparison period is invalid");
  }
  if (period.kind === "quarter" && ![1, 2, 3, 4].includes(period.fiscalQuarter ?? 0)) {
    throw new Error("quarterly financial comparison identity requires fiscalQuarter");
  }
  const basisParts = [basis.id, basis.currency, basis.accountingStandard, basis.scope, basis.revision].map((value) => required2(value, "accounting basis"));
  return JSON.stringify({
    v: 1,
    source,
    securityCode,
    statementType,
    metric,
    period: { kind: period.kind, startDate: period.startDate, endDate: period.endDate },
    accountingBasis: { id: basisParts[0], currency: basisParts[1], accountingStandard: basisParts[2], scope: basisParts[3], revision: basisParts[4] }
  });
}
function required2(value, label) {
  const result = value.trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

// src/modules/research/domain/research-financial-quality.ts
var RESEARCH_FINANCIAL_QUALITY_RULE_VERSION = "research-financial-quality.v2";
var metricAggregation = {
  revenue: "sum",
  gross_profit: "sum",
  operating_profit: "sum",
  net_profit: "sum",
  operating_cash_flow: "sum",
  capital_expenditure: "sum",
  cost_of_revenue: "sum",
  cash: "ending",
  total_debt: "ending",
  total_equity: "ending",
  total_assets: "ending",
  current_assets: "ending",
  current_liabilities: "ending",
  trade_receivables: "ending",
  contract_assets: "ending",
  inventory: "ending",
  trade_payables: "ending",
  short_term_debt: "ending",
  long_term_debt: "ending",
  lease_liabilities: "ending",
  interest_expense: "sum",
  pre_tax_profit: "sum",
  income_tax_expense: "sum",
  dividends_paid: "sum",
  share_repurchases: "sum",
  share_issuance: "sum",
  acquisition_spend: "sum",
  debt_repayment: "sum",
  diluted_weighted_average_shares: "average",
  diluted_shares: "ending"
};
var shareMetrics = /* @__PURE__ */ new Set([
  "diluted_weighted_average_shares",
  "diluted_shares"
]);
function buildResearchFinancialQuality(input) {
  validateFacts(input.facts);
  const normalizedSeries = buildNormalizedSeries(input.facts);
  const ttmSeries = buildTtmSeries(normalizedSeries);
  const series = [...normalizedSeries, ...ttmSeries].sort(compareSeries);
  const trends = series.flatMap(buildTrendObservations);
  const observations = buildQualityObservations(
    series,
    input.facts,
    // Callers without a company identity are retained for pure mechanical
    // calculation/tests. The company read model always supplies the resolved
    // profile and therefore never takes this compatibility default.
    input.entityType ?? "non_financial"
  );
  const gaps = [...trends, ...observations].filter((item) => item.status !== "available").map((item) => ({
    observationId: item.id,
    status: item.status,
    reasonCodes: item.reasonCodes
  }));
  return {
    ruleVersion: RESEARCH_FINANCIAL_QUALITY_RULE_VERSION,
    series,
    trends,
    observations,
    gaps
  };
}
function validateFacts(facts) {
  const ids = /* @__PURE__ */ new Set();
  for (const fact of facts) {
    if (!fact.id.trim() || ids.has(fact.id)) {
      throw new Error(`financial fact id must be non-empty and unique: ${fact.id}`);
    }
    ids.add(fact.id);
    if (fact.value !== null && !Number.isFinite(fact.value)) {
      throw new Error(`financial fact value must be finite or null: ${fact.id}`);
    }
    if (!fact.basis.id.trim() || !fact.basis.currency.trim() || !fact.basis.accountingStandard.trim() || !fact.basis.scope.trim() || !fact.basis.revision.trim()) {
      throw new Error(`financial fact basis is incomplete: ${fact.id}`);
    }
    if (!fact.provenance.sourceId.trim() || !fact.provenance.sourceType.trim()) {
      throw new Error(`financial fact provenance is incomplete: ${fact.id}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fact.period.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(fact.period.endDate) || fact.period.startDate > fact.period.endDate) {
      throw new Error(`financial fact period is invalid: ${fact.id}`);
    }
    if (fact.period.kind === "quarter" && ![1, 2, 3, 4].includes(fact.period.fiscalQuarter ?? 0)) {
      throw new Error(`quarterly financial fact requires fiscalQuarter: ${fact.id}`);
    }
    if (fact.period.kind === "annual" && fact.period.fiscalQuarter !== void 0) {
      throw new Error(`annual financial fact cannot have fiscalQuarter: ${fact.id}`);
    }
  }
}
function buildNormalizedSeries(facts) {
  const groups = /* @__PURE__ */ new Map();
  for (const fact of facts) {
    const frequency = fact.period.kind === "annual" ? "annual" : "quarterly";
    const key = `${basisKey(fact.basis)}|${fact.metric}|${frequency}`;
    const values2 = groups.get(key) ?? [];
    values2.push(fact);
    groups.set(key, values2);
  }
  const result = [];
  for (const group of groups.values()) {
    const first = group[0];
    const frequency = first.period.kind === "annual" ? "annual" : "quarterly";
    const byPeriod = /* @__PURE__ */ new Map();
    for (const fact of group) {
      const values2 = byPeriod.get(periodKey(fact.period)) ?? [];
      values2.push(fact);
      byPeriod.set(periodKey(fact.period), values2);
    }
    const points = [...byPeriod.values()].map(sourcePoint).sort((a, b) => comparePeriod(a.period, b.period));
    result.push({
      metric: first.metric,
      frequency,
      basis: first.basis,
      unit: metricUnit(first.metric, first.basis),
      points
    });
  }
  return result;
}
function sourcePoint(facts) {
  const available = facts.filter((fact) => fact.value !== null);
  const distinct = [...new Set(available.map((fact) => fact.value))];
  const inputs = factReferences(facts);
  const failedBridge = facts.find((fact) => fact.derivationStatus);
  if (failedBridge?.derivationStatus) {
    return {
      period: facts[0].period,
      status: failedBridge.derivationStatus,
      value: null,
      formula: failedBridge.derivationFormula ?? "source fact",
      reasonCodes: failedBridge.derivationReasonCodes ?? ["derived_fact_unavailable"],
      inputs
    };
  }
  if (distinct.length > 1) {
    return {
      period: facts[0].period,
      status: "incomparable",
      value: null,
      formula: facts[0].derivationFormula ?? "source fact",
      reasonCodes: ["conflicting_source_values"],
      inputs
    };
  }
  if (distinct.length === 0) {
    return {
      period: facts[0].period,
      status: "missing",
      value: null,
      formula: facts[0].derivationFormula ?? "source fact",
      reasonCodes: ["source_value_missing"],
      inputs
    };
  }
  return {
    period: facts[0].period,
    status: "available",
    value: distinct[0],
    formula: facts[0].derivationFormula ?? "source fact",
    reasonCodes: [],
    inputs
  };
}
function buildTtmSeries(series) {
  const result = [];
  for (const item of series.filter((candidate) => candidate.frequency === "quarterly")) {
    const aggregation = metricAggregation[item.metric];
    if (aggregation === "ending") continue;
    const byQuarter = new Map(item.points.map((point) => [quarterIndex(point.period), point]));
    const points = item.points.map((ending) => {
      const endIndex = quarterIndex(ending.period);
      const window = [endIndex - 3, endIndex - 2, endIndex - 1, endIndex].map((index) => byQuarter.get(index));
      const present = window.filter((point) => Boolean(point));
      if (present.length !== 4) {
        return unavailableSeriesPoint(
          ttmPeriod(ending.period, present[0]?.period.startDate),
          "missing",
          "four consecutive quarterly facts",
          ["insufficient_quarter_history"],
          present.flatMap((point) => point.inputs)
        );
      }
      const unusable = present.find((point) => point.status !== "available");
      if (unusable) {
        return unavailableSeriesPoint(
          ttmPeriod(ending.period, present[0]?.period.startDate),
          unusable.status === "incomparable" ? "incomparable" : "missing",
          aggregation === "sum" ? "sum(last four quarters)" : "average(last four quarters)",
          unusable.reasonCodes,
          present.flatMap((point) => point.inputs)
        );
      }
      const values2 = present.map((point) => point.value);
      return {
        period: ttmPeriod(ending.period, present[0].period.startDate),
        status: "available",
        value: aggregation === "sum" ? values2.reduce((sum, value) => sum + value, 0) : values2.reduce((sum, value) => sum + value, 0) / values2.length,
        formula: aggregation === "sum" ? "sum(last four quarters)" : "average(last four quarters)",
        reasonCodes: [],
        inputs: dedupeReferences(present.flatMap((point) => point.inputs))
      };
    });
    result.push({ ...item, frequency: "ttm", points });
  }
  return result;
}
function buildTrendObservations(series) {
  const result = [];
  const byIndex = new Map(series.points.map((point) => [periodIndex(point.period), point]));
  for (const point of series.points) {
    if (series.frequency === "annual") {
      const previous = byIndex.get(periodIndex(point.period) - 1);
      if (previous) result.push(changeObservation(series, "yoy", previous, point, 1));
      continue;
    }
    if (series.frequency === "quarterly") {
      const previousQuarter = byIndex.get(periodIndex(point.period) - 1);
      const previousYear2 = byIndex.get(periodIndex(point.period) - 4);
      if (previousQuarter) result.push(changeObservation(series, "qoq", previousQuarter, point, 1));
      if (previousYear2) result.push(changeObservation(series, "yoy", previousYear2, point, 1));
      continue;
    }
    const previousYear = byIndex.get(periodIndex(point.period) - 4);
    if (previousYear) result.push(changeObservation(series, "yoy", previousYear, point, 1));
  }
  if (series.frequency === "annual") {
    const available = series.points.filter((point) => point.status === "available");
    const first = available[0];
    const last = available.at(-1);
    const years = first && last ? last.period.fiscalYear - first.period.fiscalYear : 0;
    if (first && last && years > 1) {
      result.push(changeObservation(series, "cagr", first, last, years));
    }
  }
  return result;
}
function changeObservation(series, kind, from, to, intervals) {
  const base = observationBase(series, kind, to.period);
  const inputs = dedupeReferences([...from.inputs, ...to.inputs]);
  if (from.status !== "available" || to.status !== "available") {
    const status = from.status === "incomparable" || to.status === "incomparable" ? "incomparable" : "missing";
    return {
      ...base,
      comparisonPeriod: from.period,
      status,
      value: null,
      unit: "percent",
      formula: kind === "cagr" ? "(current / prior)^(1 / years) - 1" : "current / prior - 1",
      reasonCodes: dedupeStrings([...from.reasonCodes, ...to.reasonCodes]),
      inputs
    };
  }
  if (from.value === 0 || kind === "cagr" && (from.value < 0 || to.value < 0)) {
    return {
      ...base,
      comparisonPeriod: from.period,
      status: "not_applicable",
      value: null,
      unit: "percent",
      formula: kind === "cagr" ? "(current / prior)^(1 / years) - 1" : "current / prior - 1",
      reasonCodes: [kind === "cagr" ? "cagr_requires_positive_values" : "zero_comparison_denominator"],
      inputs
    };
  }
  const value = kind === "cagr" ? (Math.pow(to.value / from.value, 1 / intervals) - 1) * 100 : (to.value / from.value - 1) * 100;
  return {
    ...base,
    comparisonPeriod: from.period,
    status: "available",
    value,
    unit: "percent",
    formula: kind === "cagr" ? "(current / prior)^(1 / years) - 1" : "current / prior - 1",
    reasonCodes: [],
    inputs
  };
}
function buildQualityObservations(series, facts, entityType) {
  const result = [];
  const basisGroups = uniqueBases(series);
  for (const basis of basisGroups) {
    for (const frequency of ["annual", "quarterly", "ttm"]) {
      const group = series.filter((item) => basisKey(item.basis) === basisKey(basis) && item.frequency === frequency);
      const periods2 = uniquePeriods(group.flatMap((item) => item.points.map((point) => point.period)));
      for (const period of periods2) {
        result.push(ratioObservation(group, facts, basis, frequency, period, "gross_margin", "gross_profit", "revenue"));
        result.push(ratioObservation(group, facts, basis, frequency, period, "operating_margin", "operating_profit", "revenue"));
        result.push(ratioObservation(group, facts, basis, frequency, period, "net_margin", "net_profit", "revenue"));
        result.push(freeCashFlowObservation(group, facts, basis, frequency, period, entityType));
        result.push(freeCashFlowMarginObservation(group, facts, basis, frequency, period, entityType));
        result.push(ratioObservation(group, facts, basis, frequency, period, "capital_expenditure_to_revenue", "capital_expenditure", "revenue"));
        result.push(cashConversionObservation(group, facts, basis, frequency, period, entityType));
        result.push(perShareObservation(group, facts, basis, frequency, period, "net_profit_per_share", "net_profit", "diluted_weighted_average_shares"));
        result.push(perShareObservation(group, facts, basis, frequency, period, "free_cash_flow_per_share", "free_cash_flow", "diluted_weighted_average_shares", entityType));
        result.push(effectiveTaxRateObservation(group, facts, basis, frequency, period));
        result.push(nopatObservation(group, facts, basis, frequency, period, entityType));
        result.push(shareholderDistributionsObservation(group, facts, basis, frequency, period));
        result.push(netEquityDistributionObservation(group, facts, basis, frequency, period));
      }
    }
    for (const frequency of ["annual", "quarterly"]) {
      const group = series.filter((item) => basisKey(item.basis) === basisKey(basis) && item.frequency === frequency);
      const periods2 = uniquePeriods(group.flatMap((item) => item.points.map((point) => point.period)));
      for (const period of periods2) {
        result.push(netDebtObservation(group, facts, basis, frequency, period));
        result.push(perShareObservation(group, facts, basis, frequency, period, "book_value_per_share", "total_equity", "diluted_shares"));
        result.push(workingCapitalObservation(group, facts, basis, frequency, period, entityType));
        result.push(workingCapitalToRevenueObservation(group, facts, basis, frequency, period, entityType));
        result.push(ratioObservation(group, facts, basis, frequency, period, "receivables_to_revenue", "trade_receivables", "revenue"));
        result.push(ratioObservation(group, facts, basis, frequency, period, "inventory_to_revenue", "inventory", "revenue"));
        result.push(ratioObservation(group, facts, basis, frequency, period, "payables_to_revenue", "trade_payables", "revenue"));
        result.push(currentRatioObservation(group, facts, basis, frequency, period, entityType));
        result.push(quickRatioObservation(group, facts, basis, frequency, period, entityType));
        result.push(ratioObservation(group, facts, basis, frequency, period, "debt_to_equity", "total_debt", "total_equity"));
        result.push(interestCoverageObservation(group, facts, basis, frequency, period, entityType));
        result.push(dsoObservation(group, facts, basis, frequency, period, entityType));
        result.push(dioObservation(group, facts, basis, frequency, period, entityType));
        result.push(dpoObservation(group, facts, basis, frequency, period, entityType));
        result.push(cashConversionCycleObservation(result, basis, frequency, period, entityType));
        result.push(investedCapitalObservation(group, facts, basis, frequency, period, entityType));
        result.push(netDilutionRateObservation(group, facts, basis, frequency, period));
      }
    }
    result.push(...returnOnCapitalObservations(series, facts, basis, entityType));
  }
  return entityType === "unknown" ? blockUnclassifiedFinancialEntityMetrics(result) : result;
}
var unclassifiedEntityMetricKinds = /* @__PURE__ */ new Set([
  "free_cash_flow_margin",
  "cash_conversion",
  "free_cash_flow_per_share",
  "nopat",
  "working_capital",
  "working_capital_to_revenue",
  "current_ratio",
  "quick_ratio",
  "interest_coverage",
  "days_sales_outstanding",
  "days_inventory_outstanding",
  "days_payables_outstanding",
  "cash_conversion_cycle",
  "invested_capital",
  "return_on_assets",
  "return_on_invested_capital",
  "incremental_roic"
]);
function blockUnclassifiedFinancialEntityMetrics(observations) {
  return observations.map((item) => unclassifiedEntityMetricKinds.has(item.kind) ? { ...item, status: "missing", value: null, reasonCodes: ["entity_financial_profile_unconfirmed"], inputs: [] } : item);
}
function ratioObservation(series, facts, basis, frequency, period, kind, numeratorMetric, denominatorMetric) {
  const numerator = findPoint(series, numeratorMetric, period);
  const denominator = findPoint(series, denominatorMetric, period);
  return divideObservation({
    facts,
    basis,
    frequency,
    period,
    kind,
    metric: numeratorMetric,
    numerator,
    denominator,
    numeratorMetric,
    denominatorMetric,
    unit: "percent",
    multiplier: 100,
    formula: `${numeratorMetric} / ${denominatorMetric}`
  });
}
function freeCashFlowMarginObservation(series, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("free_cash_flow_margin", "free_cash_flow", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "free_cash_flow / revenue", "financial_company_fcf_not_applicable");
  const fcf = observationAsPoint(freeCashFlowObservation(series, facts, basis, frequency, period, entityType));
  const revenue = findPoint(series, "revenue", period);
  return divideAvailablePoints(base, "free_cash_flow / revenue", "percent", 100, [fcf, revenue], ["free_cash_flow", "revenue"]);
}
function workingCapitalObservation(series, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("working_capital", "working_capital", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "trade_receivables + contract_assets + inventory - trade_payables", "financial_company_working_capital_not_applicable");
  const receivables = findPoint(series, "trade_receivables", period);
  const contractAssets = findPoint(series, "contract_assets", period);
  const inventory = findPoint(series, "inventory", period);
  const payables = findPoint(series, "trade_payables", period);
  const unavailable = unavailableForInputs(base, facts, ["trade_receivables", "contract_assets", "inventory", "trade_payables"], period, basis, [receivables, contractAssets, inventory, payables]);
  if (unavailable) return { ...unavailable, formula: "trade_receivables + contract_assets + inventory - trade_payables", unit: basis.currency };
  return {
    ...base,
    status: "available",
    value: receivables.value + contractAssets.value + inventory.value - payables.value,
    unit: basis.currency,
    formula: "trade_receivables + contract_assets + inventory - trade_payables",
    reasonCodes: [],
    inputs: dedupeReferences([receivables, contractAssets, inventory, payables].flatMap((point) => point.inputs))
  };
}
function workingCapitalToRevenueObservation(series, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("working_capital_to_revenue", "working_capital", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "working_capital / revenue", "financial_company_working_capital_not_applicable");
  const workingCapital = observationAsPoint(workingCapitalObservation(series, facts, basis, frequency, period, entityType));
  const revenue = findPoint(series, "revenue", period);
  return divideAvailablePoints(base, "working_capital / revenue", "percent", 100, [workingCapital, revenue], ["working_capital", "revenue"]);
}
function currentRatioObservation(series, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("current_ratio", "current_assets", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "current_assets / current_liabilities", "financial_company_current_ratio_not_applicable");
  return divideObservation({
    facts,
    basis,
    frequency,
    period,
    kind: "current_ratio",
    metric: "current_assets",
    numerator: findPoint(series, "current_assets", period),
    denominator: findPoint(series, "current_liabilities", period),
    numeratorMetric: "current_assets",
    denominatorMetric: "current_liabilities",
    unit: "times",
    multiplier: 1,
    formula: "current_assets / current_liabilities"
  });
}
function quickRatioObservation(series, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("quick_ratio", "current_assets", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "(cash + trade_receivables + contract_assets) / current_liabilities", "financial_company_quick_ratio_not_applicable");
  const cash = findPoint(series, "cash", period);
  const receivables = findPoint(series, "trade_receivables", period);
  const contractAssets = findPoint(series, "contract_assets", period);
  const liabilities = findPoint(series, "current_liabilities", period);
  const quickAssets = combinePoints(base, "quick_assets", "cash + trade_receivables + contract_assets", basis.currency, [cash, receivables, contractAssets], ["cash", "trade_receivables", "contract_assets"]);
  return divideAvailablePoints(base, "(cash + trade_receivables + contract_assets) / current_liabilities", "times", 1, [quickAssets, liabilities], ["quick_assets", "current_liabilities"]);
}
function interestCoverageObservation(series, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("interest_coverage", "operating_profit", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "operating_profit / interest_expense", "financial_company_interest_coverage_not_applicable");
  const operatingProfit = findPoint(series, "operating_profit", period);
  const interest = findPoint(series, "interest_expense", period);
  const result = divideObservation({
    facts,
    basis,
    frequency,
    period,
    kind: "interest_coverage",
    metric: "operating_profit",
    numerator: operatingProfit,
    denominator: interest,
    numeratorMetric: "operating_profit",
    denominatorMetric: "interest_expense",
    unit: "times",
    multiplier: 1,
    formula: "operating_profit / interest_expense"
  });
  if (result.status !== "available") return result;
  if (operatingProfit.value <= 0 || interest.value <= 0) return {
    ...result,
    status: "not_applicable",
    value: null,
    reasonCodes: [operatingProfit.value <= 0 ? "non_positive_operating_profit" : "non_positive_interest_expense"]
  };
  return result;
}
function effectiveTaxRateObservation(series, facts, basis, frequency, period) {
  const base = observationBaseFor("effective_tax_rate", "income_tax_expense", basis, frequency, period);
  const tax = findPoint(series, "income_tax_expense", period);
  const pretax = findPoint(series, "pre_tax_profit", period);
  const unavailable = unavailableForInputs(base, facts, ["income_tax_expense", "pre_tax_profit"], period, basis, [tax, pretax]);
  if (unavailable) return { ...unavailable, formula: "income_tax_expense / pre_tax_profit", unit: "percent" };
  if (pretax.value <= 0 || tax.value < 0 || tax.value > pretax.value) {
    return {
      ...base,
      status: "not_applicable",
      value: null,
      unit: "percent",
      formula: "income_tax_expense / pre_tax_profit",
      reasonCodes: [pretax.value <= 0 ? "non_positive_pre_tax_profit" : "tax_rate_outside_0_100_percent"],
      inputs: dedupeReferences([...tax.inputs, ...pretax.inputs])
    };
  }
  return {
    ...base,
    status: "available",
    value: tax.value / pretax.value * 100,
    unit: "percent",
    formula: "income_tax_expense / pre_tax_profit",
    reasonCodes: [],
    inputs: dedupeReferences([...tax.inputs, ...pretax.inputs])
  };
}
function nopatObservation(series, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("nopat", "nopat", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "operating_profit \xD7 (1 - effective_tax_rate)", "financial_company_nopat_not_applicable");
  const operatingProfit = findPoint(series, "operating_profit", period);
  const taxRate = observationAsPoint(effectiveTaxRateObservation(series, facts, basis, frequency, period));
  const unavailable = unavailableFromPoints(base, [operatingProfit, taxRate], ["operating_profit", "effective_tax_rate"]);
  if (unavailable) return { ...unavailable, formula: "operating_profit \xD7 (1 - effective_tax_rate)", unit: basis.currency };
  return {
    ...base,
    status: "available",
    value: operatingProfit.value * (1 - taxRate.value / 100),
    unit: basis.currency,
    formula: "operating_profit \xD7 (1 - effective_tax_rate)",
    reasonCodes: [],
    inputs: dedupeReferences([...operatingProfit.inputs, ...taxRate.inputs])
  };
}
function shareholderDistributionsObservation(series, facts, basis, frequency, period) {
  const base = observationBaseFor("shareholder_distributions", "shareholder_distributions", basis, frequency, period);
  const dividends = findPoint(series, "dividends_paid", period);
  const repurchases = findPoint(series, "share_repurchases", period);
  const unavailable = unavailableForInputs(base, facts, ["dividends_paid", "share_repurchases"], period, basis, [dividends, repurchases]);
  if (unavailable) return { ...unavailable, formula: "dividends_paid + share_repurchases", unit: basis.currency };
  return {
    ...base,
    status: "available",
    value: dividends.value + repurchases.value,
    unit: basis.currency,
    formula: "dividends_paid + share_repurchases (positive cash outflows)",
    reasonCodes: [],
    inputs: dedupeReferences([...dividends.inputs, ...repurchases.inputs])
  };
}
function netEquityDistributionObservation(series, facts, basis, frequency, period) {
  const base = observationBaseFor("net_equity_distribution", "net_equity_distribution", basis, frequency, period);
  const distributions = observationAsPoint(shareholderDistributionsObservation(series, facts, basis, frequency, period));
  const issuance = findPoint(series, "share_issuance", period);
  return subtractAvailablePoints(base, "shareholder_distributions - share_issuance", basis.currency, distributions, issuance, "shareholder_distributions", "share_issuance");
}
function dsoObservation(series, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("days_sales_outstanding", "trade_receivables", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "average(trade_receivables + contract_assets) / revenue \xD7 days", "financial_company_cash_conversion_cycle_not_applicable");
  return turnoverDaysObservation({ base, series, facts, basis, frequency, period, balanceMetrics: ["trade_receivables", "contract_assets"], denominatorMetric: "revenue", kind: "days_sales_outstanding", label: "trade_receivables + contract_assets" });
}
function dioObservation(series, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("days_inventory_outstanding", "inventory", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "average(inventory) / cost_of_revenue \xD7 days", "financial_company_cash_conversion_cycle_not_applicable");
  return turnoverDaysObservation({ base, series, facts, basis, frequency, period, balanceMetrics: ["inventory"], denominatorMetric: "cost_of_revenue", kind: "days_inventory_outstanding", label: "inventory" });
}
function dpoObservation(series, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("days_payables_outstanding", "trade_payables", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "average(trade_payables) / cost_of_revenue \xD7 days", "financial_company_cash_conversion_cycle_not_applicable");
  return turnoverDaysObservation({ base, series, facts, basis, frequency, period, balanceMetrics: ["trade_payables"], denominatorMetric: "cost_of_revenue", kind: "days_payables_outstanding", label: "trade_payables" });
}
function turnoverDaysObservation(options) {
  const { base, series, facts, basis, frequency, period, balanceMetrics, denominatorMetric, label } = options;
  const current = combinePoints(base, label, label, basis.currency, balanceMetrics.map((metric) => findPoint(series, metric, period)), balanceMetrics);
  const priorPeriod = priorComparablePeriod(period, frequency);
  const prior = priorPeriod ? combinePoints(base, label, label, basis.currency, balanceMetrics.map((metric) => findPoint(series, metric, priorPeriod)), balanceMetrics) : unavailablePoint(period, "missing", ["prior_period_required_for_average_balance"]);
  const denominator = findPoint(series, denominatorMetric, period);
  const unavailable = unavailableFromPoints(base, [current, prior, denominator], [label, `prior_${label}`, denominatorMetric]);
  const formula = `average(${label}) / ${denominatorMetric} \xD7 period_days`;
  if (unavailable) return { ...unavailable, formula, unit: "days" };
  const usableDenominator = denominator;
  if (usableDenominator.value <= 0) return {
    ...base,
    status: "not_applicable",
    value: null,
    unit: "days",
    formula,
    reasonCodes: [`non_positive_${denominatorMetric}`],
    inputs: dedupeReferences([...current.inputs, ...prior.inputs, ...usableDenominator.inputs])
  };
  return {
    ...base,
    status: "available",
    value: (current.value + prior.value) / 2 / usableDenominator.value * periodDays(period),
    unit: "days",
    formula,
    reasonCodes: [],
    inputs: dedupeReferences([...current.inputs, ...prior.inputs, ...usableDenominator.inputs])
  };
}
function cashConversionCycleObservation(observations, basis, frequency, period, entityType) {
  const base = observationBaseFor("cash_conversion_cycle", "working_capital", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "DSO + DIO - DPO", "financial_company_cash_conversion_cycle_not_applicable");
  const find = (kind) => observations.find((item) => item.kind === kind && item.frequency === frequency && item.period.endDate === period.endDate && basisKey(item.basis) === basisKey(basis));
  const dso = find("days_sales_outstanding");
  const dio = find("days_inventory_outstanding");
  const dpo = find("days_payables_outstanding");
  const points = [dso, dio, dpo].map((item) => item ? observationAsPoint(item) : void 0);
  const unavailable = unavailableFromPoints(base, points, ["days_sales_outstanding", "days_inventory_outstanding", "days_payables_outstanding"]);
  if (unavailable) return { ...unavailable, formula: "DSO + DIO - DPO", unit: "days" };
  return {
    ...base,
    status: "available",
    value: points[0].value + points[1].value - points[2].value,
    unit: "days",
    formula: "DSO + DIO - DPO",
    reasonCodes: [],
    inputs: dedupeReferences(points.flatMap((point) => point.inputs))
  };
}
function investedCapitalObservation(series, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("invested_capital", "invested_capital", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "total_equity + total_debt - cash", "financial_company_invested_capital_not_applicable");
  const equity = findPoint(series, "total_equity", period);
  const debt = findPoint(series, "total_debt", period);
  const cash = findPoint(series, "cash", period);
  const unavailable = unavailableForInputs(base, facts, ["total_equity", "total_debt", "cash"], period, basis, [equity, debt, cash]);
  if (unavailable) return { ...unavailable, formula: "total_equity + total_debt - cash", unit: basis.currency };
  const value = equity.value + debt.value - cash.value;
  if (value <= 0) return {
    ...base,
    status: "not_applicable",
    value: null,
    unit: basis.currency,
    formula: "total_equity + total_debt - cash",
    reasonCodes: ["non_positive_invested_capital"],
    inputs: dedupeReferences([...equity.inputs, ...debt.inputs, ...cash.inputs])
  };
  return {
    ...base,
    status: "available",
    value,
    unit: basis.currency,
    formula: "total_equity + total_debt - cash",
    reasonCodes: [],
    inputs: dedupeReferences([...equity.inputs, ...debt.inputs, ...cash.inputs])
  };
}
function netDilutionRateObservation(series, facts, basis, frequency, period) {
  const base = observationBaseFor("net_dilution_rate", "diluted_shares", basis, frequency, period);
  const current = findPoint(series, "diluted_shares", period);
  const previousPeriod = priorComparablePeriod(period, frequency);
  const previous = previousPeriod ? findPoint(series, "diluted_shares", previousPeriod) : void 0;
  const unavailable = unavailableForInputs(base, facts, ["diluted_shares", "diluted_shares"], period, basis, [current, previous]);
  if (unavailable) return { ...unavailable, formula: "current diluted_shares / prior diluted_shares - 1", unit: "percent" };
  if (previous.value <= 0) return {
    ...base,
    status: "not_applicable",
    value: null,
    unit: "percent",
    formula: "current diluted_shares / prior diluted_shares - 1",
    reasonCodes: ["non_positive_prior_diluted_shares"],
    inputs: dedupeReferences([...current.inputs, ...previous.inputs])
  };
  return {
    ...base,
    status: "available",
    value: (current.value / previous.value - 1) * 100,
    unit: "percent",
    formula: "current diluted_shares / prior diluted_shares - 1",
    reasonCodes: [],
    inputs: dedupeReferences([...current.inputs, ...previous.inputs])
  };
}
function returnOnCapitalObservations(series, facts, basis, entityType) {
  const result = [];
  for (const frequency of ["annual", "ttm"]) {
    const flows = series.filter((item) => basisKey(item.basis) === basisKey(basis) && item.frequency === frequency);
    const balanceFrequency = frequency === "annual" ? "annual" : "quarterly";
    const balances = series.filter((item) => basisKey(item.basis) === basisKey(basis) && item.frequency === balanceFrequency);
    const netProfit = flows.find((item) => item.metric === "net_profit");
    if (!netProfit) continue;
    for (const point of netProfit.points) {
      result.push(returnOnEquityObservation(flows, balances, facts, basis, frequency, point.period));
      result.push(returnOnAssetsObservation(flows, balances, facts, basis, frequency, point.period, entityType));
      result.push(returnOnInvestedCapitalObservation(flows, balances, facts, basis, frequency, point.period, entityType));
      result.push(incrementalRoicObservation(flows, balances, facts, basis, frequency, point.period, entityType));
    }
  }
  return result;
}
function returnOnEquityObservation(flows, balances, facts, basis, frequency, period) {
  return returnOnAverageBalanceObservation({ kind: "return_on_equity", metric: "net_profit", numeratorMetric: "net_profit", balanceMetric: "total_equity", formula: "net_profit / average(total_equity)", flows, balances, facts, basis, frequency, period });
}
function returnOnAssetsObservation(flows, balances, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("return_on_assets", "net_profit", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "net_profit / average(total_assets)", "financial_company_return_on_assets_not_applicable");
  return returnOnAverageBalanceObservation({ kind: "return_on_assets", metric: "net_profit", numeratorMetric: "net_profit", balanceMetric: "total_assets", formula: "net_profit / average(total_assets)", flows, balances, facts, basis, frequency, period });
}
function returnOnInvestedCapitalObservation(flows, balances, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("return_on_invested_capital", "nopat", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "NOPAT / average(invested_capital)", "financial_company_return_on_invested_capital_not_applicable");
  const nopat = observationAsPoint(nopatObservation(flows, facts, basis, frequency, period, entityType));
  const current = observationAsPoint(investedCapitalObservation(balances, facts, basis, frequency === "annual" ? "annual" : "quarterly", period, entityType));
  const priorPeriod = priorAnnualBalancePeriod(period, frequency);
  const previous = priorPeriod ? observationAsPoint(investedCapitalObservation(balances, facts, basis, frequency === "annual" ? "annual" : "quarterly", priorPeriod, entityType)) : unavailablePoint(period, "missing", ["prior_period_required_for_average_invested_capital"]);
  return returnOnAveragePoints(base, "NOPAT / average(invested_capital)", nopat, current, previous);
}
function incrementalRoicObservation(flows, balances, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("incremental_roic", "nopat", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "\u0394NOPAT / \u0394invested_capital", "financial_company_incremental_roic_not_applicable");
  const currentNopat = observationAsPoint(nopatObservation(flows, facts, basis, frequency, period, entityType));
  const priorFlowPeriod = priorComparablePeriod(period, frequency === "annual" ? "annual" : "quarterly", frequency === "ttm" ? 4 : 1);
  const previousNopat = priorFlowPeriod ? observationAsPoint(nopatObservation(flows, facts, basis, frequency, priorFlowPeriod, entityType)) : unavailablePoint(period, "missing", ["prior_period_required_for_incremental_roic"]);
  const balanceFrequency = frequency === "annual" ? "annual" : "quarterly";
  const currentCapital = observationAsPoint(investedCapitalObservation(balances, facts, basis, balanceFrequency, period, entityType));
  const previousCapital = priorFlowPeriod ? observationAsPoint(investedCapitalObservation(balances, facts, basis, balanceFrequency, priorFlowPeriod, entityType)) : unavailablePoint(period, "missing", ["prior_period_required_for_incremental_roic"]);
  const unavailable = unavailableFromPoints(base, [currentNopat, previousNopat, currentCapital, previousCapital], ["nopat", "prior_nopat", "invested_capital", "prior_invested_capital"]);
  if (unavailable) return { ...unavailable, formula: "\u0394NOPAT / \u0394invested_capital", unit: "percent" };
  const capitalChange = currentCapital.value - previousCapital.value;
  if (capitalChange <= 0) return {
    ...base,
    status: "not_applicable",
    value: null,
    unit: "percent",
    formula: "\u0394NOPAT / \u0394invested_capital",
    reasonCodes: ["non_positive_incremental_invested_capital"],
    inputs: dedupeReferences([currentNopat, previousNopat, currentCapital, previousCapital].flatMap((point) => point.inputs))
  };
  return {
    ...base,
    status: "available",
    value: (currentNopat.value - previousNopat.value) / capitalChange * 100,
    unit: "percent",
    formula: "\u0394NOPAT / \u0394invested_capital",
    reasonCodes: [],
    inputs: dedupeReferences([currentNopat, previousNopat, currentCapital, previousCapital].flatMap((point) => point.inputs))
  };
}
function returnOnAverageBalanceObservation(options) {
  const { kind, metric, numeratorMetric, balanceMetric, formula, flows, balances, facts, basis, frequency, period } = options;
  const base = observationBaseFor(kind, metric, basis, frequency, period);
  const numerator = findPoint(flows, numeratorMetric, period);
  const current = findPoint(balances, balanceMetric, period);
  const priorPeriod = priorAnnualBalancePeriod(period, frequency);
  const prior = priorPeriod ? findPoint(balances, balanceMetric, priorPeriod) : void 0;
  const unavailable = unavailableForInputs(base, facts, [numeratorMetric, balanceMetric, balanceMetric], period, basis, [numerator, current, prior]);
  if (unavailable) return { ...unavailable, formula, unit: "percent" };
  return divideAverageBalance(base, formula, numerator, current, prior);
}
function returnOnAveragePoints(base, formula, numerator, current, prior) {
  const unavailable = unavailableFromPoints(base, [numerator, current, prior], ["numerator", "current_balance", "prior_balance"]);
  if (unavailable) return { ...unavailable, formula, unit: "percent" };
  return divideAverageBalance(base, formula, numerator, current, prior);
}
function divideAverageBalance(base, formula, numerator, current, prior) {
  const average = (current.value + prior.value) / 2;
  if (average <= 0) return {
    ...base,
    status: "not_applicable",
    value: null,
    unit: "percent",
    formula,
    reasonCodes: ["non_positive_average_balance"],
    inputs: dedupeReferences([...numerator.inputs, ...current.inputs, ...prior.inputs])
  };
  return {
    ...base,
    status: "available",
    value: numerator.value / average * 100,
    unit: "percent",
    formula,
    reasonCodes: [],
    inputs: dedupeReferences([...numerator.inputs, ...current.inputs, ...prior.inputs])
  };
}
function freeCashFlowObservation(series, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("free_cash_flow", "free_cash_flow", basis, frequency, period);
  if (entityType === "financial") {
    return notApplicable(base, "operating_cash_flow - capital_expenditure", "financial_company_fcf_not_applicable");
  }
  const cashFlow = findPoint(series, "operating_cash_flow", period);
  const capex = findPoint(series, "capital_expenditure", period);
  const unavailable = unavailableForInputs(base, facts, ["operating_cash_flow", "capital_expenditure"], period, basis, [cashFlow, capex]);
  if (unavailable) return { ...unavailable, formula: "operating_cash_flow - capital_expenditure", unit: basis.currency };
  return {
    ...base,
    status: "available",
    value: cashFlow.value - capex.value,
    unit: basis.currency,
    formula: "operating_cash_flow - capital_expenditure (capital expenditure is a positive outflow)",
    reasonCodes: [],
    inputs: dedupeReferences([...cashFlow.inputs, ...capex.inputs])
  };
}
function cashConversionObservation(series, facts, basis, frequency, period, entityType) {
  const base = observationBaseFor("cash_conversion", "operating_cash_flow", basis, frequency, period);
  if (entityType === "financial") {
    return notApplicable(base, "operating_cash_flow / net_profit", "financial_company_cash_conversion_not_applicable");
  }
  const cashFlow = findPoint(series, "operating_cash_flow", period);
  const profit = findPoint(series, "net_profit", period);
  const unavailable = unavailableForInputs(base, facts, ["operating_cash_flow", "net_profit"], period, basis, [cashFlow, profit]);
  if (unavailable) return { ...unavailable, formula: "operating_cash_flow / net_profit", unit: "percent" };
  if (profit.value <= 0) {
    return {
      ...base,
      status: "not_applicable",
      value: null,
      unit: "percent",
      formula: "operating_cash_flow / net_profit",
      reasonCodes: ["non_positive_profit_denominator"],
      inputs: dedupeReferences([...cashFlow.inputs, ...profit.inputs])
    };
  }
  return {
    ...base,
    status: "available",
    value: cashFlow.value / profit.value * 100,
    unit: "percent",
    formula: "operating_cash_flow / net_profit",
    reasonCodes: [],
    inputs: dedupeReferences([...cashFlow.inputs, ...profit.inputs])
  };
}
function netDebtObservation(series, facts, basis, frequency, period) {
  const base = observationBaseFor("net_debt", "net_debt", basis, frequency, period);
  const debt = findPoint(series, "total_debt", period);
  const cash = findPoint(series, "cash", period);
  const unavailable = unavailableForInputs(base, facts, ["total_debt", "cash"], period, basis, [debt, cash]);
  if (unavailable) return { ...unavailable, formula: "total_debt - cash", unit: basis.currency };
  return {
    ...base,
    status: "available",
    value: debt.value - cash.value,
    unit: basis.currency,
    formula: "total_debt - cash",
    reasonCodes: [],
    inputs: dedupeReferences([...debt.inputs, ...cash.inputs])
  };
}
function perShareObservation(series, facts, basis, frequency, period, kind, numeratorMetric, shareMetric, entityType = "non_financial") {
  const base = observationBaseFor(kind, numeratorMetric, basis, frequency, period);
  if (numeratorMetric === "free_cash_flow" && entityType === "financial") {
    return notApplicable(base, "free_cash_flow / diluted_weighted_average_shares", "financial_company_fcf_not_applicable");
  }
  const numerator = numeratorMetric === "free_cash_flow" ? freeCashFlowObservation(series, facts, basis, frequency, period, entityType) : findPoint(series, numeratorMetric, period);
  const shares = findPoint(series, shareMetric, period);
  const numeratorPoint = numeratorMetric === "free_cash_flow" ? observationAsPoint(numerator) : numerator;
  const unavailable = unavailableForInputs(base, facts, [numeratorMetric, shareMetric], period, basis, [numeratorPoint, shares]);
  if (unavailable) return { ...unavailable, formula: `${numeratorMetric} / ${shareMetric}`, unit: `${basis.currency}/share` };
  if (shares.value <= 0) {
    return {
      ...base,
      status: "not_applicable",
      value: null,
      unit: `${basis.currency}/share`,
      formula: `${numeratorMetric} / ${shareMetric}`,
      reasonCodes: ["non_positive_share_denominator"],
      inputs: dedupeReferences([...numeratorPoint.inputs, ...shares.inputs])
    };
  }
  return {
    ...base,
    status: "available",
    value: numeratorPoint.value / shares.value,
    unit: `${basis.currency}/share`,
    formula: `${numeratorMetric} / ${shareMetric}`,
    reasonCodes: [],
    inputs: dedupeReferences([...numeratorPoint.inputs, ...shares.inputs])
  };
}
function divideObservation(options) {
  const base = observationBaseFor(options.kind, options.metric, options.basis, options.frequency, options.period);
  const unavailable = unavailableForInputs(
    base,
    options.facts,
    [options.numeratorMetric, options.denominatorMetric],
    options.period,
    options.basis,
    [options.numerator, options.denominator]
  );
  if (unavailable) return { ...unavailable, formula: options.formula, unit: options.unit };
  if (options.denominator.value === 0) {
    return {
      ...base,
      status: "not_applicable",
      value: null,
      unit: options.unit,
      formula: options.formula,
      reasonCodes: ["zero_denominator"],
      inputs: dedupeReferences([...options.numerator.inputs, ...options.denominator.inputs])
    };
  }
  return {
    ...base,
    status: "available",
    value: options.numerator.value / options.denominator.value * options.multiplier,
    unit: options.unit,
    formula: options.formula,
    reasonCodes: [],
    inputs: dedupeReferences([...options.numerator.inputs, ...options.denominator.inputs])
  };
}
function unavailableForInputs(base, facts, metrics, period, basis, points) {
  const defined = points.filter((point) => Boolean(point));
  const inputs = dedupeReferences(defined.flatMap((point) => point.inputs));
  if (defined.some((point) => point.status === "incomparable")) {
    return {
      ...base,
      status: "incomparable",
      value: null,
      unit: "",
      formula: "",
      reasonCodes: dedupeStrings(defined.flatMap((point) => point.reasonCodes)),
      inputs
    };
  }
  const unavailableMetric = metrics.find((_, index) => !points[index] || points[index].status !== "available");
  if (!unavailableMetric) return null;
  const otherBasisExists = unavailableMetric !== "free_cash_flow" && facts.some(
    (fact) => fact.metric === unavailableMetric && periodKey(fact.period) === periodKey(period) && basisKey(fact.basis) !== basisKey(basis) && fact.value !== null
  );
  return {
    ...base,
    status: otherBasisExists ? "incomparable" : "missing",
    value: null,
    unit: "",
    formula: "",
    reasonCodes: [otherBasisExists ? "required_fact_has_different_basis" : `missing_${unavailableMetric}`],
    inputs
  };
}
function unavailableFromPoints(base, points, labels) {
  const defined = points.filter((point) => Boolean(point));
  const inputs = dedupeReferences(defined.flatMap((point) => point.inputs));
  if (defined.some((point) => point.status === "incomparable")) {
    return { ...base, status: "incomparable", value: null, unit: "", formula: "", reasonCodes: dedupeStrings(defined.flatMap((point) => point.reasonCodes)), inputs };
  }
  const unavailableIndex = points.findIndex((point) => !point || point.status !== "available");
  if (unavailableIndex < 0) return null;
  const unavailable = points[unavailableIndex];
  return {
    ...base,
    status: unavailable?.status === "not_applicable" ? "not_applicable" : "missing",
    value: null,
    unit: "",
    formula: "",
    reasonCodes: unavailable?.reasonCodes.length ? unavailable.reasonCodes : [`missing_${labels[unavailableIndex]}`],
    inputs
  };
}
function unavailablePoint(period, status, reasonCodes) {
  return { period, status, value: null, formula: "", reasonCodes, inputs: [] };
}
function combinePoints(base, _label, formula, unit, points, labels) {
  const unavailable = unavailableFromPoints({
    id: "derived-input",
    kind: "working_capital",
    metric: "working_capital",
    basis: { id: "derived", currency: unit, accountingStandard: "derived", scope: "derived", revision: "derived" },
    frequency: "annual",
    period: base.period
  }, points, labels);
  if (unavailable) return { period: base.period, status: unavailable.status, value: null, formula, reasonCodes: unavailable.reasonCodes, inputs: unavailable.inputs };
  return {
    period: base.period,
    status: "available",
    value: points.reduce((total, point) => total + point.value, 0),
    formula,
    reasonCodes: [],
    inputs: dedupeReferences(points.flatMap((point) => point.inputs))
  };
}
function divideAvailablePoints(base, formula, unit, multiplier, points, labels) {
  const unavailable = unavailableFromPoints(base, points, labels);
  if (unavailable) return { ...unavailable, formula, unit };
  const [numerator, denominator] = points;
  if (denominator.value === 0) return {
    ...base,
    status: "not_applicable",
    value: null,
    unit,
    formula,
    reasonCodes: ["zero_denominator"],
    inputs: dedupeReferences([...numerator.inputs, ...denominator.inputs])
  };
  return {
    ...base,
    status: "available",
    value: numerator.value / denominator.value * multiplier,
    unit,
    formula,
    reasonCodes: [],
    inputs: dedupeReferences([...numerator.inputs, ...denominator.inputs])
  };
}
function subtractAvailablePoints(base, formula, unit, left, right, leftLabel, rightLabel) {
  const unavailable = unavailableFromPoints(base, [left, right], [leftLabel, rightLabel]);
  if (unavailable) return { ...unavailable, formula, unit };
  return {
    ...base,
    status: "available",
    value: left.value - right.value,
    unit,
    formula,
    reasonCodes: [],
    inputs: dedupeReferences([...left.inputs, ...right.inputs])
  };
}
function priorComparablePeriod(period, frequency, steps = 1) {
  if (frequency === "annual") return { ...period, kind: "annual", fiscalYear: period.fiscalYear - steps, startDate: `${period.fiscalYear - steps}-01-01`, endDate: `${period.fiscalYear - steps}${period.endDate.slice(4)}`, fiscalQuarter: void 0 };
  const current = quarterIndex(period) - steps;
  const fiscalYear = Math.floor(current / 4);
  const fiscalQuarter = current % 4 + 1;
  const month = fiscalQuarter * 3;
  return { kind: "quarter", fiscalYear, fiscalQuarter, startDate: `${fiscalYear}-${String(month - 2).padStart(2, "0")}-01`, endDate: `${fiscalYear}-${String(month).padStart(2, "0")}-${fiscalQuarter === 1 || fiscalQuarter === 4 ? "31" : "30"}` };
}
function priorAnnualBalancePeriod(period, frequency) {
  return priorComparablePeriod(period, frequency === "annual" ? "annual" : "quarterly", frequency === "annual" ? 1 : 4);
}
function periodDays(period) {
  const start = Date.parse(`${period.startDate}T00:00:00Z`);
  const end = Date.parse(`${period.endDate}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 864e5) + 1 : 0;
}
function observationBase(series, kind, period) {
  return observationBaseFor(kind, series.metric, series.basis, series.frequency, period);
}
function observationBaseFor(kind, metric, basis, frequency, period) {
  return {
    id: `${kind}:${metric}:${frequency}:${periodKey(period)}:${basisKey(basis)}`,
    kind,
    metric,
    basis,
    frequency,
    period
  };
}
function notApplicable(base, formula, reason) {
  return {
    ...base,
    status: "not_applicable",
    value: null,
    unit: "",
    formula,
    reasonCodes: [reason],
    inputs: []
  };
}
function observationAsPoint(observation) {
  return {
    period: observation.period,
    status: observation.status,
    value: observation.value,
    formula: observation.formula,
    reasonCodes: observation.reasonCodes,
    inputs: observation.inputs
  };
}
function findPoint(series, metric, period) {
  return series.find((item) => item.metric === metric)?.points.find((point) => periodKey(point.period) === periodKey(period));
}
function uniqueBases(series) {
  const values2 = /* @__PURE__ */ new Map();
  for (const item of series) values2.set(basisKey(item.basis), item.basis);
  return [...values2.values()];
}
function uniquePeriods(periods2) {
  const values2 = /* @__PURE__ */ new Map();
  for (const period of periods2) values2.set(periodKey(period), period);
  return [...values2.values()].sort(comparePeriod);
}
function metricUnit(metric, basis) {
  return shareMetrics.has(metric) ? "shares" : basis.currency;
}
function basisKey(basis) {
  return [basis.id, basis.currency, basis.accountingStandard, basis.scope, basis.revision].join("~");
}
function periodKey(period) {
  return period.kind === "annual" ? `FY${period.fiscalYear}:${period.endDate}` : `FY${period.fiscalYear}Q${period.fiscalQuarter}:${period.endDate}`;
}
function periodIndex(period) {
  return period.kind === "annual" ? period.fiscalYear : quarterIndex(period);
}
function quarterIndex(period) {
  return period.fiscalYear * 4 + (period.fiscalQuarter ?? 4) - 1;
}
function ttmPeriod(ending, startDate = ending.startDate) {
  return {
    kind: "quarter",
    startDate,
    endDate: ending.endDate,
    fiscalYear: ending.fiscalYear,
    fiscalQuarter: ending.fiscalQuarter
  };
}
function unavailableSeriesPoint(period, status, formula, reasonCodes, inputs) {
  return { period, status, value: null, formula, reasonCodes, inputs: dedupeReferences(inputs) };
}
function factReferences(facts) {
  return facts.flatMap((fact) => fact.inputReferences?.length ? fact.inputReferences : [{ factId: fact.id, provenance: fact.provenance }]);
}
function dedupeReferences(inputs) {
  return [...new Map(inputs.map((item) => [item.factId, item])).values()];
}
function dedupeStrings(values2) {
  return [...new Set(values2)];
}
function comparePeriod(left, right) {
  return left.endDate.localeCompare(right.endDate) || periodKey(left).localeCompare(periodKey(right));
}
function compareSeries(left, right) {
  return basisKey(left.basis).localeCompare(basisKey(right.basis)) || left.metric.localeCompare(right.metric) || left.frequency.localeCompare(right.frequency);
}

// src/modules/research/application/research-financials.ts
async function loadResearchFinancialFactSet(env, code) {
  const security = classifyResearchSecurity({ code, instrumentType: "stock" });
  const statementTypes = ["income", "balance", "cashflow"];
  const loaded = await Promise.all(statementTypes.map(async (statementType) => {
    const result = await loadFinancialStatementReadModel(env, code, statementType, { httpOptions: externalHttpOptions(env) });
    return { statementType, result, error: result.sourceHealth.message };
  }));
  return {
    security,
    loaded,
    facts: loaded.flatMap(({ statementType, result }) => normalizeStatementRows(statementType, result.rows)),
    sourceErrors: loaded.filter((item) => item.result.sourceHealth.status === "failed"),
    primaryAvailable: loaded.every(({ result }) => Boolean(result.rows.length))
  };
}
function normalizeStatementRows(statementType, rows) {
  if (rows.some((row) => isHongKongCumulativeRow(row))) {
    return normalizeHongKongStatementRows(statementType, rows);
  }
  return rows.flatMap((row, rowIndex) => {
    const payload2 = row.payload && typeof row.payload === "object" ? row.payload : {};
    if (row.source === "yahoo" && (!hasYahooReportingMetadata2(payload2) || payload2.YAHOO_CURRENCY_CONFLICT === true)) return [];
    const period = parsePeriod(payload2, row.reportDate, row.source);
    if (!period) return [];
    const values2 = statementValues(statementType, payload2);
    const currency = text3(payload2.REPORTING_CURRENCY) ?? text3(payload2.CURRENCY) ?? (row.code.endsWith(".HK") ? "HKD" : "CNY");
    const sourceId = `${row.source}:${row.code}:${statementType}:${row.reportDate}:${row.fiscalPeriod || payload2.FISCAL_PERIOD || "unknown"}:${rowIndex}`;
    const accountingStandard = row.code.endsWith(".HK") ? text3(payload2.REPORTING_ACCOUNT_STANDARD) ?? text3(payload2.ACCOUNT_STANDARD) ?? "IFRS" : row.code.endsWith(".US") ? "US_GAAP" : "CAS";
    const basis = { id: `${currency}:${accountingStandard}:consolidated:reported`, currency, accountingStandard, scope: "consolidated", revision: "reported" };
    return values2.map(([metric, value]) => ({
      id: `${sourceId}:${metric}`,
      canonicalComparisonKey: canonicalFinancialComparisonKey({ source: row.source, securityCode: row.code, statementType, metric, period, basis }),
      metric,
      period,
      value,
      basis,
      provenance: { sourceId, sourceType: row.source, publishedAt: text3(payload2.NOTICE_DATE) ?? row.reportDate, locator: metric }
    })).map((fact, _, facts) => deriveGrossProfitFact(facts, fact, { securityCode: row.code, source: row.source, statementType, sourceId, period, basis, publishedAt: text3(payload2.NOTICE_DATE) ?? row.reportDate }));
  });
}
function hasYahooReportingMetadata2(payload2) {
  return (payload2.FINANCIAL_SOURCE_CONTRACT === "yahoo_finance_timeseries.v2" || payload2.FINANCIAL_SOURCE_CONTRACT === "yahoo_finance_timeseries.v3") && typeof payload2.REPORTING_CURRENCY === "string" && payload2.REPORTING_CURRENCY.trim().length > 0 && typeof payload2.FISCAL_PERIOD === "string" && payload2.FISCAL_PERIOD.trim().length > 0;
}
function normalizeHongKongStatementRows(statementType, rows) {
  const sources = rows.flatMap((row, rowIndex) => normalizeHongKongRow(statementType, row, rowIndex));
  if (statementType !== "income" && statementType !== "cashflow") return sources.flatMap((item) => item.facts);
  const output = sources.filter((item) => item.dateType === "001").flatMap((item) => item.facts.map((fact) => {
    const period = annualPeriod(item.period.fiscalYear, item.period.endDate);
    return {
      ...fact,
      period,
      canonicalComparisonKey: canonicalFinancialComparisonKey({
        source: fact.provenance.sourceType,
        securityCode: item.securityCode,
        statementType: item.statementType,
        metric: fact.metric,
        period,
        basis: fact.basis
      })
    };
  }));
  const byYearAndMetric = /* @__PURE__ */ new Map();
  for (const source of sources) {
    if (!source.dateType || source.dateType === "001") continue;
    for (const fact of source.facts) {
      const key = `${source.period.fiscalYear}|${fact.metric}`;
      const values2 = byYearAndMetric.get(key) ?? [];
      values2.push({ ...source, fact });
      byYearAndMetric.set(key, values2);
    }
  }
  for (const source of sources.filter((item) => item.dateType === "001")) {
    for (const fact of source.facts) {
      const key = `${source.period.fiscalYear}|${fact.metric}`;
      const values2 = byYearAndMetric.get(key) ?? [];
      values2.push({ ...source, fact });
      byYearAndMetric.set(key, values2);
    }
  }
  for (const values2 of byYearAndMetric.values()) output.push(...bridgeHongKongCumulativeMetric(values2));
  return output;
}
function normalizeHongKongRow(statementType, row, rowIndex) {
  const payload2 = row.payload && typeof row.payload === "object" ? row.payload : {};
  const period = parseHongKongPeriod(payload2, row.reportDate);
  if (!period) return [];
  const currency = text3(payload2.REPORTING_CURRENCY) ?? text3(payload2.CURRENCY) ?? "HKD";
  const accountingStandard = text3(payload2.REPORTING_ACCOUNT_STANDARD) ?? text3(payload2.ACCOUNT_STANDARD) ?? "IFRS";
  const basis = { id: `${currency}:${accountingStandard}:consolidated:reported`, currency, accountingStandard, scope: "consolidated", revision: "reported" };
  const sourceId = `${row.source}:${row.code}:${statementType}:${row.reportDate}:${rowIndex}`;
  const provenance = { sourceId, sourceType: row.source, publishedAt: text3(payload2.NOTICE_DATE) ?? row.reportDate };
  const facts = statementValues(statementType, payload2).map(([metric, value]) => ({
    id: `${sourceId}:${metric}`,
    canonicalComparisonKey: canonicalFinancialComparisonKey({ source: row.source, securityCode: row.code, statementType, metric, period, basis }),
    metric,
    period,
    value,
    basis,
    provenance: { ...provenance, locator: metric }
  }));
  return [{ securityCode: row.code, statementType, dateType: text3(payload2.DATE_TYPE_CODE), period, fact: facts[0], facts }];
}
function bridgeHongKongCumulativeMetric(values2) {
  const byType = new Map(values2.map((item) => [item.dateType, item]));
  const metric = values2[0]?.fact.metric;
  if (!metric) return [];
  const q1 = byType.get("003");
  const h1 = byType.get("002");
  const m9 = byType.get("004");
  const fy = byType.get("001");
  const result = [];
  if (q1) result.push(derivedHongKongQuarter(metric, q1.period.fiscalYear, 1, [q1], "Q1 reported cumulative value"));
  if (h1 && q1) result.push(derivedHongKongQuarter(metric, h1.period.fiscalYear, 2, [h1, q1], "H1 cumulative value - Q1 cumulative value"));
  if (m9 && h1) result.push(derivedHongKongQuarter(metric, m9.period.fiscalYear, 3, [m9, h1], "9M cumulative value - H1 cumulative value"));
  if (fy && m9) result.push(derivedHongKongQuarter(metric, fy.period.fiscalYear, 4, [fy, m9], "FY cumulative value - 9M cumulative value"));
  return result;
}
function derivedHongKongQuarter(metric, fiscalYear, fiscalQuarter, inputs, formula) {
  const [first, second] = inputs;
  if (!first) throw new Error("Hong Kong cumulative bridge requires a reported input");
  const mixedBasis = inputs.some((item) => !sameBasis(item.fact.basis, first.fact.basis));
  const missingInput = inputs.some((item) => item.fact.value === null);
  const value = mixedBasis || missingInput ? null : second ? first.fact.value - second.fact.value : first.fact.value;
  const inputReferences = inputs.map((item) => ({
    factId: item.fact.id,
    provenance: item.fact.provenance
  }));
  const endDate = quarterEndDate(fiscalYear, fiscalQuarter);
  const period = { kind: "quarter", startDate: `${fiscalYear}-${String((fiscalQuarter - 1) * 3 + 1).padStart(2, "0")}-01`, endDate, fiscalYear, fiscalQuarter };
  return {
    id: `hk-cumulative-bridge:${first.securityCode}:${first.statementType}:${metric}:${fiscalYear}:Q${fiscalQuarter}:${first.fact.basis.id}`,
    canonicalComparisonKey: canonicalFinancialComparisonKey({
      source: "derived_from_eastmoney_hk_f10",
      securityCode: first.securityCode,
      statementType: first.statementType,
      metric,
      period,
      basis: first.fact.basis
    }),
    metric,
    period,
    value,
    basis: first.fact.basis,
    provenance: {
      sourceId: `hk-cumulative-bridge:${first.fact.provenance.sourceId}`,
      sourceType: "derived_from_eastmoney_hk_f10",
      publishedAt: first.fact.provenance.publishedAt,
      locator: formula
    },
    inputReferences,
    derivationFormula: formula,
    derivationStatus: mixedBasis ? "incomparable" : missingInput ? "missing" : void 0,
    derivationReasonCodes: mixedBasis ? ["cumulative_bridge_mixed_accounting_basis"] : missingInput ? ["cumulative_bridge_input_missing"] : void 0
  };
}
function isHongKongCumulativeRow(row) {
  const payload2 = row.payload && typeof row.payload === "object" ? row.payload : {};
  return text3(payload2.FINANCIAL_SOURCE_CONTRACT) === "eastmoney_hk_f10_main_indicator.v1";
}
function parseHongKongPeriod(payload2, fallback) {
  const date = (text3(payload2.REPORT_DATE) ?? fallback).slice(0, 10);
  const match2 = date.match(/^(\d{4})-(03|06|09|12)-(31|30)$/);
  if (!match2) return null;
  const fiscalYear = Number(match2[1]);
  const fiscalQuarter = { "03": 1, "06": 2, "09": 3, "12": 4 }[match2[2]];
  return { kind: "quarter", startDate: `${fiscalYear}-${String((fiscalQuarter - 1) * 3 + 1).padStart(2, "0")}-01`, endDate: date, fiscalYear, fiscalQuarter };
}
function annualPeriod(fiscalYear, endDate) {
  return { kind: "annual", startDate: `${fiscalYear}-01-01`, endDate, fiscalYear };
}
function quarterEndDate(fiscalYear, fiscalQuarter) {
  const month = String(fiscalQuarter * 3).padStart(2, "0");
  return `${fiscalYear}-${month}-${fiscalQuarter === 1 || fiscalQuarter === 4 ? "31" : "30"}`;
}
function sameBasis(left, right) {
  return left.id === right.id;
}
function statementValues(statementType, payload2) {
  if (statementType === "income") return [
    ["revenue", numberOf(payload2.TOTAL_OPERATE_INCOME) ?? numberOf(payload2.OPERATE_INCOME) ?? numberOf(payload2.totalOperateIncome)],
    ["cost_of_revenue", numberOf(payload2.OPERATE_COST) ?? numberOf(payload2.TOTAL_OPERATE_COST) ?? numberOf(payload2.operateCost)],
    ["gross_profit", numberOf(payload2.GROSS_PROFIT) ?? numberOf(payload2.grossProfit)],
    ["operating_profit", numberOf(payload2.OPERATE_PROFIT) ?? numberOf(payload2.operateProfit)],
    ["net_profit", numberOf(payload2.PARENT_NETPROFIT) ?? numberOf(payload2.HOLDER_PROFIT) ?? numberOf(payload2.NETPROFIT) ?? numberOf(payload2.parentNetprofit) ?? numberOf(payload2.netProfit)],
    ["pre_tax_profit", numberOf(payload2.TOTAL_PROFIT) ?? numberOf(payload2.PROFIT_BEFORE_TAX) ?? numberOf(payload2.pretaxIncome)],
    ["income_tax_expense", numberOf(payload2.INCOME_TAX) ?? numberOf(payload2.INCOME_TAX_EXPENSE) ?? numberOf(payload2.taxProvision)],
    ["interest_expense", numberOf(payload2.INTEREST_EXPENSE) ?? numberOf(payload2.interestExpense)],
    // An issued/common-share field is a point-in-time basic share count, not
    // an EPS denominator.  It must enter the separately reviewed security
    // market-structure ledger with an explicit measurement basis; do not
    // relabel it as either diluted weighted-average shares or period-end
    // diluted shares just because this statement happens to contain it.
    ["diluted_weighted_average_shares", numberOf(payload2.DILUTED_AVERAGE_SHARES)]
  ];
  if (statementType === "balance") return [
    ["cash", numberOf(payload2.MONETARYFUNDS) ?? numberOf(payload2.END_CASH) ?? numberOf(payload2.endCce)],
    // Total liabilities is not debt.  Only a source's explicitly labeled total debt is admitted.
    ["total_debt", numberOf(payload2.TOTAL_DEBT) ?? numberOf(payload2.totalDebt)],
    ["total_equity", numberOf(payload2.TOTAL_EQUITY) ?? numberOf(payload2.TOTAL_PARENT_EQUITY) ?? numberOf(payload2.totalEquity)],
    ["total_assets", numberOf(payload2.TOTAL_ASSETS) ?? numberOf(payload2.TOTAL_ASSET) ?? numberOf(payload2.totalAssets) ?? numberOf(payload2.totaAssets)],
    ["current_assets", numberOf(payload2.TOTAL_CURRENT_ASSETS) ?? numberOf(payload2.CURRENT_ASSETS) ?? numberOf(payload2.currentAssets)],
    ["current_liabilities", numberOf(payload2.TOTAL_CURRENT_LIAB) ?? numberOf(payload2.TOTAL_CURRENT_LIABILITIES) ?? numberOf(payload2.currentLiabilities)],
    ["trade_receivables", numberOf(payload2.ACCOUNT_RECE) ?? numberOf(payload2.ACCOUNTS_RECEIVABLE) ?? numberOf(payload2.accountsReceivable)],
    ["contract_assets", numberOf(payload2.CONTRACT_ASSET) ?? numberOf(payload2.contractAssets)],
    ["inventory", numberOf(payload2.INVENTORY) ?? numberOf(payload2.inventories)],
    ["trade_payables", numberOf(payload2.ACCOUNT_PAYABLE) ?? numberOf(payload2.ACCOUNTS_PAYABLE) ?? numberOf(payload2.accountsPayable)],
    ["short_term_debt", numberOf(payload2.SHORTTERM_LOAN) ?? numberOf(payload2.SHORT_TERM_DEBT) ?? numberOf(payload2.shortTermDebt)],
    ["long_term_debt", numberOf(payload2.LONGTERM_LOAN) ?? numberOf(payload2.LONG_TERM_DEBT) ?? numberOf(payload2.longTermDebt)],
    ["lease_liabilities", numberOf(payload2.LEASE_LIABILITY) ?? numberOf(payload2.leaseLiabilities)]
  ];
  return [
    ["operating_cash_flow", numberOf(payload2.NETCASH_OPERATE) ?? numberOf(payload2.netcashOperate)],
    ["capital_expenditure", numberOf(payload2.CONSTRUCT_LONG_ASSET)],
    // These fields are admitted only when the upstream payload states the cash-flow direction as an outflow/inflow.
    // No absolute-value conversion is used: a source with an ambiguous sign remains unavailable to derived allocation metrics.
    ["dividends_paid", nonNegativeCashAmount(payload2.DIVIDEND_PAID) ?? nonNegativeCashAmount(payload2.dividendsPaid)],
    ["share_repurchases", nonNegativeCashAmount(payload2.SHARE_REPURCHASES) ?? nonNegativeCashAmount(payload2.shareRepurchases)],
    ["share_issuance", nonNegativeCashAmount(payload2.SHARE_ISSUANCE) ?? nonNegativeCashAmount(payload2.shareIssuance)],
    ["acquisition_spend", nonNegativeCashAmount(payload2.ACQUISITION_SPEND) ?? nonNegativeCashAmount(payload2.acquisitionSpend)],
    ["debt_repayment", nonNegativeCashAmount(payload2.DEBT_REPAYMENT) ?? nonNegativeCashAmount(payload2.debtRepayment)]
  ];
}
function parsePeriod(payload2, fallback, source) {
  const date = (text3(payload2.REPORT_DATE) ?? fallback).slice(0, 10);
  const match2 = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match2) return null;
  const fiscalYear = Number(match2[1]);
  if (text3(payload2.FINANCIAL_SOURCE_CONTRACT) === "eastmoney_hk_f10_main_indicator.v1") {
    if (String(payload2.DATE_TYPE_CODE ?? "") !== "001") return null;
    return { kind: "annual", startDate: `${fiscalYear}-01-01`, endDate: date, fiscalYear };
  }
  const month = Number(match2[2]);
  const day = Number(match2[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(fiscalYear, month, 0)).getUTCDate()) return null;
  if (/^(12M|FY|ANNUAL)$/i.test(String(payload2.FISCAL_PERIOD ?? payload2.fiscalPeriod ?? "")) || source === "eastmoney" && (text3(payload2.FINANCIAL_SOURCE_CONTRACT) === "eastmoney_f10_annual_income.v1" || /^(?:年报|年度报告|年度)$/.test(String(payload2.REPORT_TYPE ?? "").trim())) && month === 12 && day === 31) {
    return { kind: "annual", startDate: `${fiscalYear}-01-01`, endDate: date, fiscalYear };
  }
  const quarter = Math.ceil(month / 3);
  const start = `${fiscalYear}-${String((quarter - 1) * 3 + 1).padStart(2, "0")}-01`;
  return { kind: "quarter", startDate: start, endDate: date, fiscalYear, fiscalQuarter: quarter };
}
function numberOf(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function deriveGrossProfitFact(facts, fact, options) {
  if (options.statementType !== "income" || fact.metric !== "gross_profit" || fact.value !== null) return fact;
  const revenue = facts.find((item) => item.metric === "revenue" && item.value !== null);
  const cost = facts.find((item) => item.metric === "cost_of_revenue" && item.value !== null);
  if (!revenue || !cost) return fact;
  return {
    id: `${options.sourceId}:gross_profit:derived`,
    canonicalComparisonKey: canonicalFinancialComparisonKey({
      source: options.source,
      securityCode: options.securityCode,
      statementType: options.statementType,
      metric: "gross_profit",
      period: options.period,
      basis: options.basis
    }),
    metric: "gross_profit",
    period: options.period,
    value: revenue.value - cost.value,
    basis: options.basis,
    provenance: {
      sourceId: options.sourceId,
      sourceType: options.source,
      publishedAt: options.publishedAt,
      locator: "gross_profit"
    },
    derivationFormula: "revenue - cost_of_revenue",
    inputReferences: [
      { factId: revenue.id, provenance: revenue.provenance },
      { factId: cost.id, provenance: cost.provenance }
    ]
  };
}
function nonNegativeCashAmount(value) {
  const parsed = numberOf(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}
function text3(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// src/generated/prompt-text.ts
var RESEARCH_FINANCIAL_ANALYSIS_PROMPT = "\u4F60\u662F\u4E25\u8C28\u7684\u4E0A\u5E02\u516C\u53F8\u8D22\u52A1\u7814\u7A76\u5458\u3002\u8BF7\u57FA\u4E8E\u4E0B\u65B9\u5DF2\u786E\u8BA4\u7684\u8D22\u52A1\u8D44\u6599\u64B0\u5199\u62A5\u544A\uFF0C\u4E0D\u5F97\u4F7F\u7528\u6A21\u578B\u8BB0\u5FC6\u8865\u9F50\u7F3A\u53E3\uFF1B\u4E25\u683C\u6309\u8F93\u51FA\u6807\u9898\u8FD4\u56DE\u3002\u4EC5\u5728\u666E\u901A\u804A\u5929\u56DE\u590D\u4E2D\u8F93\u51FA\u539F\u59CB Markdown \u6B63\u6587\uFF0C\u4E0D\u8981\u521B\u5EFA\u6216\u4F7F\u7528 Canvas\u3001\u53EF\u7F16\u8F91\u6587\u6863\uFF0C\u4E5F\u4E0D\u8981\u5C06\u62A5\u544A\u4F5C\u4E3A\u4E0B\u8F7D\u6587\u4EF6\u6216\u9644\u4EF6\u4EA4\u4ED8\u3002\n\n\u53EA\u4F7F\u7528\u5DF2\u63D0\u4F9B\u7684\u8D22\u52A1\u4E8B\u5B9E\u3001\u8D8B\u52BF\u4E0E\u6548\u7387\u6307\u6807\u3001\u98CE\u9669\u63D0\u793A\u548C\u9644\u6CE8\u8BC1\u636E\uFF1B\u4E0D\u5F97\u91CD\u65B0\u8BA1\u7B97\u4EFB\u4F55\u6570\u503C\u3002\n\n\u8D44\u6599\u4E2D\u7684\u8D22\u52A1\u8868\u3001\u8D8B\u52BF\u4E0E\u6548\u7387\u6307\u6807\u53CA\u5173\u952E\u6458\u8981\u662F\u552F\u4E00\u7684\u6570\u636E\u4F9D\u636E\u3002\u8D22\u52A1\u8868\u6309\u671F\u95F4\u5217\u793A\u5404\u9879\u6307\u6807\uFF0C\u4E0D\u8981\u628A\u5B83\u4EEC\u673A\u68B0\u5C55\u5F00\u6210\u9010\u6761\u6D41\u6C34\u8D26\u3002`null` \u8868\u793A\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u503C\uFF0C\u4E0D\u80FD\u5F53\u4F5C\u96F6\u6216\u5B89\u5168\uFF1B\u8D44\u6599\u4E2D\u7684\u6570\u636E\u7F3A\u53E3\u8BF4\u660E\u5176\u53D7\u5F71\u54CD\u8303\u56F4\u3002\u98CE\u9669\u63D0\u793A\u662F\u6309\u5DF2\u7ED9\u5B9A\u6570\u503C\u8BC6\u522B\u51FA\u7684\u5F02\u5E38\u4FE1\u53F7\uFF0C\u4E0D\u7B49\u4E8E\u9020\u5047\u6216\u6700\u7EC8\u7ED3\u8BBA\uFF1B\u4F60\u5FC5\u987B\u89E3\u91CA\u53EF\u80FD\u539F\u56E0\u3001\u53CD\u8BC1\u548C\u4E0B\u671F\u9A8C\u8BC1\u9879\u3002\u8D44\u6599\u5B8C\u6574\u6027\u6807\u4E3A `partial` \u6216 `blocked` \u65F6\uFF0C\u5148\u8BF4\u660E\u53D7\u5F71\u54CD\u7684\u6838\u9A8C\u8303\u56F4\u3002\u4E0D\u5F97\u8F93\u51FA\u76EE\u6807\u4EF7\u3001\u4EA4\u6613\u5EFA\u8BAE\u6216\u603B\u5206\u3002\n\n\u91D1\u989D\u5DF2\u7EDF\u4E00\u4E3A\u4EBF\u5143\u3001\u80A1\u6570\u5DF2\u7EDF\u4E00\u4E3A\u4EBF\u80A1\u3001\u767E\u5206\u6BD4\u5DF2\u4FDD\u7559\u4E24\u4F4D\u5C0F\u6570\u3002\u76F4\u63A5\u4F7F\u7528\u7ED9\u5B9A\u7684\u6570\u503C\u548C\u5355\u4F4D\uFF0C\u4E0D\u5F97\u81EA\u884C\u6362\u7B97\u3002\u5173\u952E\u6458\u8981\u5DF2\u6574\u7406\u6700\u65B0\u5E74\u5EA6\u3001\u6700\u65B0\u5B63\u5EA6\u3001\u540C\u6BD4\u3001\u73AF\u6BD4\u548C\u91CD\u70B9\u89C2\u5BDF\u9879\uFF1B\u9664\u975E\u4E3A\u4E86\u8BF4\u660E\u8D8B\u52BF\u62D0\u70B9\u6216\u53E3\u5F84\u53D8\u5316\uFF0C\u4E0D\u8981\u987A\u5E8F\u91CD\u6284\u6574\u5F20\u6570\u636E\u8868\u3002\u4F18\u5148\u5F15\u7528\u5404\u7AE0\u8282\u76F8\u5173\u7684\u6458\u8981\u6570\u5B57\uFF0C\u628A\u7BC7\u5E45\u7528\u4E8E\u89E3\u91CA\u53D8\u5316\u3001\u53CD\u8BC1\u3001\u9650\u5236\u548C\u4E0B\u671F\u9A8C\u8BC1\u9879\u3002\u82E5\u8D44\u6599\u5DF2\u7ED9\u51FA\u540C\u6BD4\u6216\u73AF\u6BD4\uFF0C\u76F4\u63A5\u4F7F\u7528\u5373\u53EF\u3002\n\n\u6B63\u6587\u4EC5\u5305\u542B\u4EE5\u4E0B\u516B\u4E2A\u4E00\u7EA7\u7AE0\u8282\uFF1A\n# 1. \u6570\u636E\u8986\u76D6\u3001\u53E3\u5F84\u4E0E\u53EF\u4FE1\u5EA6\n# 2. \u6536\u5165\u589E\u957F\u3001\u540C\u6BD4\u73AF\u6BD4\u4E0E\u76C8\u5229\u80FD\u529B\n# 3. \u5229\u6DA6\u8D28\u91CF\u3001\u73B0\u91D1\u6D41\u4E0E\u8425\u8FD0\u8D44\u672C\n# 4. \u8D44\u672C\u6548\u7387\u3001\u518D\u6295\u8D44\u4E0E ROIC\n# 5. \u8D44\u4EA7\u8D1F\u503A\u8868\u3001\u503A\u52A1\u4E0E\u6D41\u52A8\u6027\u538B\u529B\n# 6. \u6BCF\u80A1\u4EF7\u503C\u3001\u7A00\u91CA\u4E0E\u8D44\u672C\u914D\u7F6E\n# 7. \u8D22\u52A1\u98CE\u9669\u9690\u60A3\u3001\u53CD\u8BC1\u4E0E\u4E0B\u671F\u76D1\u63A7\n# 8. \u6761\u4EF6\u5316\u8D22\u52A1\u7EFC\u5408\u7ED3\u8BBA\n\n\u62A5\u544A\u6B63\u6587\u4E0D\u5F97\u51FA\u73B0\u201C\u4F9D\u636E\uFF1A\u201D\u3001\u539F\u59CB\u5B57\u6BB5\u540D\u3001\u8D44\u6599\u5185\u90E8\u7F16\u53F7\u6216\u5176\u4ED6\u6280\u672F\u6027\u6807\u7B7E\uFF1B\u4E0D\u5F97\u628A\u7F3A\u5931\u9879\u9690\u53BB\u3002\n\n## \u5DF2\u786E\u8BA4\u7684\u8D22\u52A1\u8D44\u6599\n\n{{INPUT_DATA}}";
var RESEARCH_OPERATING_ANALYSIS_PROMPT = "# \u6295\u8D44\u5206\u6790\u6700\u7EC8\u62A5\u544A\n\n\u4F60\u662F\u4E25\u8C28\u7684\u6295\u8D44\u7814\u7A76\u5458\u3002\u8BF7\u57FA\u4E8E\u4E0B\u65B9\u5DF2\u786E\u8BA4\u4FE1\u606F\uFF0C\u5E76\u901A\u8FC7 Web Search \u6838\u9A8C\u548C\u8865\u5145\u516C\u5F00\u8D44\u6599\uFF0C\u64B0\u5199\u4E00\u4EFD\u5173\u4E8E\u76EE\u6807\u516C\u53F8\u7684\u5B8C\u6574\u3001\u53EF\u8BFB\u3001\u53EF\u5BA1\u8BA1\u7684\u4E2D\u6587\u6295\u8D44\u5206\u6790\u62A5\u544A\uFF1B\u4E0D\u5F97\u4EE5\u6A21\u578B\u8BB0\u5FC6\u586B\u8865\u4FE1\u606F\u7F3A\u53E3\uFF0C\u5E76\u4E25\u683C\u6309\u4E0B\u5217\u8F93\u51FA\u683C\u5F0F\u8FD4\u56DE\u3002\n\n**\u4EA4\u4ED8\u65B9\u5F0F\u662F\u666E\u901A\u804A\u5929\u6D88\u606F\u4E2D\u7684\u539F\u59CB Markdown \u6B63\u6587\u3002** \u76F4\u63A5\u5728\u672C\u6B21\u56DE\u590D\u4E2D\u8F93\u51FA\u62A5\u544A\u672C\u8EAB\uFF1B\u4E0D\u5F97\u521B\u5EFA\u6216\u4F7F\u7528 Canvas\u3001\u53EF\u7F16\u8F91\u6587\u6863\uFF0C\u4E5F\u4E0D\u5F97\u5C06\u62A5\u544A\u4F5C\u4E3A\u4E0B\u8F7D\u6587\u4EF6\u6216\u9644\u4EF6\u4EA4\u4ED8\u3002\u4E0D\u8981\u8F93\u51FA JSON\u3001\u4EE3\u7801\u56F4\u680F\u3001\u4E0E\u62A5\u544A\u65E0\u5173\u7684\u8FC7\u7A0B\u8BF4\u660E\u6216\u5355\u72EC\u7684\u6765\u6E90\u6E05\u5355\u3002\n\n\u4E0B\u65B9\u7684\u7814\u7A76\u5BF9\u8C61\u548C\u5E02\u573A\u5FEB\u7167\u662F\u5DF2\u786E\u8BA4\u4FE1\u606F\uFF1A\u5E02\u573A\u5FEB\u7167\u53EA\u7528\u4E8E\u62A5\u544A\u65F6\u70B9\u7684\u4EF7\u683C\u4E0E\u4F30\u503C\u500D\u6570\uFF0C\u4E0D\u8981\u7528\u641C\u7D22\u7ED3\u679C\u8986\u76D6\u3002\u5386\u53F2\u8D22\u62A5\u3001\u4E1A\u52A1\u6570\u636E\u548C\u6765\u6E90\u987B\u4ECE\u516C\u53F8\u3001\u76D1\u7BA1\u3001\u4EA4\u6613\u6240\u7B49\u516C\u5F00\u62AB\u9732\u4E2D\u6838\u9A8C\uFF0C\u5E76\u5728\u6B63\u6587\u9644\u8FD1\u94FE\u63A5\uFF1B\u65E0\u6CD5\u6838\u9A8C\u65F6\u660E\u786E\u4FDD\u7559\u672A\u77E5\uFF0C\u4E0D\u5F97\u7528\u6A21\u578B\u8BB0\u5FC6\u6216\u63A8\u65AD\u8865\u6570\u3002\u7814\u7A76\u6846\u67B6\u53EA\u7528\u4E8E\u7EC4\u7EC7\u56E0\u679C\u94FE\u548C\u60C5\u666F\u5206\u6790\uFF1A\u4F18\u5148\u6838\u9A8C\u5217\u51FA\u7684\u7ECF\u8425\u6307\u6807\uFF0C\u6309\u53EF\u7528\u4F30\u503C\u65B9\u6CD5\u9009\u62E9\u9002\u7528\u65B9\u6CD5\uFF0C\u5E76\u7528\u538B\u529B\u56E0\u7D20\u5EFA\u7ACB\u60C5\u666F\uFF1B\u4E0D\u5F97\u628A\u6846\u67B6\u672C\u8EAB\u5F53\u6210\u516C\u53F8\u4E8B\u5B9E\u3002\u5FC5\u8981\u65F6\u8865\u5145\u540C\u884C\u62AB\u9732\u3001\u6743\u5A01\u5A92\u4F53\u548C\u53EF\u516C\u5F00\u8BBF\u95EE\u7684\u7814\u7A76\u8D44\u6599\uFF0C\u5E76\u81EA\u7136\u533A\u5206\u516C\u53F8\u62AB\u9732\u3001\u5916\u90E8\u8BC1\u636E\u3001\u7BA1\u7406\u5C42\u8BA1\u5212\u3001\u5206\u6790\u5224\u65AD\u548C\u672A\u77E5\u9879\u3002\n\n\u62A5\u544A\u4F7F\u7528\u4EE5\u4E0B\u7AE0\u8282\uFF0C\u6807\u9898\u53EF\u4FDD\u6301\u4E00\u81F4\u5E76\u53EF\u5728\u7AE0\u8282\u5185\u6DFB\u52A0\u7B80\u6D01\u5C0F\u6807\u9898\uFF1A\n\n# 1. \u7814\u7A76\u8303\u56F4\u4E0E\u4E8B\u5B9E\u8FB9\u754C\n# 2. \u516C\u53F8\u6982\u51B5\u4E0E\u5546\u4E1A\u6A21\u5F0F\n# 3. \u884C\u4E1A\u4E0E\u4EA7\u4E1A\u94FE\n# 4. \u516C\u53F8\u7ADE\u4E89\u5730\u4F4D\n# 5. \u589E\u957F\u3001\u9A71\u52A8\u4E0E\u53EF\u6301\u7EED\u6027\n# 6. \u5229\u6DA6\u8D28\u91CF\u3001\u73B0\u91D1\u8F6C\u6362\u4E0E\u8425\u8FD0\u8D44\u672C\n# 7. \u8D44\u672C\u6548\u7387\u3001\u7BA1\u7406\u5C42\u6CBB\u7406\u4E0E\u8D44\u672C\u914D\u7F6E\n# 8. \u8D44\u4EA7\u8D1F\u503A\u8868\u4E0E\u538B\u529B\u6D4B\u8BD5\n# 9. \u4F30\u503C\u4E0E\u5E02\u573A\u9690\u542B\u7ECF\u8425\u8981\u6C42\n# 10. \u6838\u5FC3\u98CE\u9669\u4E0E\u53CD\u9762\u8BC1\u636E\n# 11. \u540E\u7EED\u8DDF\u8E2A\u4EEA\u8868\u76D8\n# 12. \u6700\u7EC8\u7ED3\u8BBA\n\n\u6BCF\u7AE0\u5148\u7ED9\u51FA\u6E05\u6670\u7ED3\u8BBA\uFF0C\u518D\u8BF4\u660E\u4F9D\u636E\u3001\u671F\u95F4\u3001\u53E3\u5F84\u3001\u9650\u5236\u548C\u4ECD\u5F85\u9A8C\u8BC1\u7684\u95EE\u9898\u3002\u628A\u9700\u6C42\u3001\u9500\u91CF/\u4EF7\u683C/\u7EC4\u5408\u3001\u6536\u5165\u3001\u5229\u6DA6\u7387\u3001\u73B0\u91D1\u548C\u8D44\u672C\u6295\u5165\u4E4B\u95F4\u7684\u56E0\u679C\u94FE\u5199\u6E05\u695A\uFF1B\u540C\u884C\u6BD4\u8F83\u987B\u8BF4\u660E\u53EF\u6BD4\u8FB9\u754C\u3002\u4F30\u503C\u7AE0\u8282\u7ED9\u51FA\u60B2\u89C2\u3001\u57FA\u51C6\u3001\u4E50\u89C2\u7684\u5047\u8BBE\u8303\u56F4\u3001\u5173\u952E\u654F\u611F\u53D8\u91CF\u548C\u5F53\u524D\u4EF7\u683C\u9690\u542B\u7684\u7ECF\u8425\u8981\u6C42\uFF0C\u533A\u5206\u4E8B\u5B9E\u4E0E\u4F30\u8BA1\uFF0C\u4E0D\u7F16\u9020\u76EE\u6807\u4EF7\u6216\u786E\u5B9A\u6027\u8BA1\u7B97\u7ED3\u679C\u3002\u98CE\u9669\u7AE0\u8282\u63CF\u8FF0\u4ECE\u4E8B\u4EF6\u5230\u7ECF\u8425\u53D8\u91CF\u3001\u8D22\u52A1\u9879\u76EE\u548C\u4F30\u503C\u5F71\u54CD\u7684\u4F20\u5BFC\uFF0C\u5E76\u7ED9\u51FA\u53EF\u89C2\u5BDF\u7684\u8DDF\u8E2A\u6307\u6807\u3001\u9891\u7387\u548C\u89E6\u53D1\u9608\u503C\u3002\u7ED3\u8BBA\u5E94\u6982\u62EC\u652F\u6301\u903B\u8F91\u3001\u53CD\u9762\u8BC1\u636E\u3001\u5931\u6548\u8DEF\u5F84\u548C\u4E0B\u4E00\u6B65\u89C2\u5BDF\u91CD\u70B9\uFF0C\u4E0D\u66FF\u7528\u6237\u505A\u65E0\u4F9D\u636E\u7684\u4EA4\u6613\u627F\u8BFA\u3002\n\n\u5728\u6B63\u6587\u76F8\u5173\u53E5\u5B50\u9644\u8FD1\u81EA\u7136\u653E\u7F6E\u53EF\u6838\u9A8C\u94FE\u63A5\uFF1B\u6709\u6765\u6E90\u65F6\u4F18\u5148\u94FE\u63A5\u5230\u539F\u59CB\u9875\u9762\uFF0C\u94FE\u63A5\u5E94\u670D\u52A1\u4E8E\u4E0A\u4E0B\u6587\uFF0C\u4E0D\u8981\u4E3A\u4E86\u5F62\u5F0F\u5806\u780C\u94FE\u63A5\uFF0C\u4E5F\u4E0D\u8981\u53E6\u5217\u201C\u6765\u6E90/\u8BC1\u636E ID\u201D\u9644\u5F55\u3002\u5386\u53F2\u6570\u503C\u4FDD\u7559\u6765\u6E90\u7684\u671F\u95F4\u3001\u5355\u4F4D\u3001\u5E01\u79CD\u548C\u53E3\u5F84\uFF1B\u5E02\u573A\u5FEB\u7167\u5E94\u8BF4\u660E\u5176\u6765\u6E90\u548C\u622A\u81F3\u65F6\u95F4\uFF0C\u4E0D\u4F2A\u9020\u94FE\u63A5\u3002\n\n{{INPUT_DATA}}";

// config/research-financial-analysis-risk-rules.json
var research_financial_analysis_risk_rules_default = {
  version: "financial-analysis-risk-rules.v1",
  rules: [
    { id: "revenue_yoy_decline", observationKind: "yoy", metric: "revenue", frequency: "quarterly", operator: "lt", threshold: 0, severity: "high", title: "\u6536\u5165\u540C\u6BD4\u4E0B\u964D" },
    { id: "revenue_qoq_decline", observationKind: "qoq", metric: "revenue", frequency: "quarterly", operator: "lt", threshold: 0, severity: "medium", title: "\u6536\u5165\u73AF\u6BD4\u4E0B\u964D" },
    { id: "operating_profit_yoy_decline", observationKind: "yoy", metric: "operating_profit", frequency: "quarterly", operator: "lt", threshold: 0, severity: "high", title: "\u8425\u4E1A\u5229\u6DA6\u540C\u6BD4\u4E0B\u964D" },
    { id: "net_profit_yoy_decline", observationKind: "yoy", metric: "net_profit", frequency: "quarterly", operator: "lt", threshold: 0, severity: "high", title: "\u51C0\u5229\u6DA6\u540C\u6BD4\u4E0B\u964D" },
    { id: "operating_margin_contraction", observationKind: "operating_margin", frequency: "ttm", operator: "delta_lt", threshold: -3, severity: "medium", title: "TTM \u8425\u4E1A\u5229\u6DA6\u7387\u6536\u7F29\u8D85\u8FC7 3 \u4E2A\u767E\u5206\u70B9" },
    { id: "cash_conversion_weak", observationKind: "cash_conversion", frequency: "ttm", operator: "lt", threshold: 80, severity: "high", title: "TTM \u7ECF\u8425\u73B0\u91D1\u6D41/\u51C0\u5229\u6DA6\u4F4E\u4E8E 80%" },
    { id: "cash_conversion_deteriorating", observationKind: "cash_conversion", frequency: "ttm", operator: "delta_lt", threshold: -20, severity: "medium", title: "TTM \u7ECF\u8425\u73B0\u91D1\u6D41/\u51C0\u5229\u6DA6\u8F83\u4E0A\u671F\u4E0B\u964D\u8D85\u8FC7 20 \u4E2A\u767E\u5206\u70B9" },
    { id: "free_cash_flow_negative", observationKind: "free_cash_flow", frequency: "ttm", operator: "lt", threshold: 0, severity: "medium", title: "TTM \u81EA\u7531\u73B0\u91D1\u6D41\u4E3A\u8D1F" },
    { id: "receivables_buildup", observationKind: "receivables_to_revenue", frequency: "quarterly", operator: "delta_gt", threshold: 3, severity: "medium", title: "\u5E94\u6536\u5360\u6536\u5165\u6BD4\u4E0A\u5347\u8D85\u8FC7 3 \u4E2A\u767E\u5206\u70B9" },
    { id: "inventory_buildup", observationKind: "inventory_to_revenue", frequency: "quarterly", operator: "delta_gt", threshold: 3, severity: "medium", title: "\u5B58\u8D27\u5360\u6536\u5165\u6BD4\u4E0A\u5347\u8D85\u8FC7 3 \u4E2A\u767E\u5206\u70B9" },
    { id: "leverage_high", observationKind: "debt_to_equity", frequency: "annual", operator: "gt", threshold: 100, severity: "medium", title: "\u503A\u52A1/\u6743\u76CA\u9AD8\u4E8E 100%" },
    { id: "interest_coverage_low", observationKind: "interest_coverage", frequency: "ttm", operator: "lt", threshold: 2, severity: "high", title: "TTM \u5229\u606F\u8986\u76D6\u4F4E\u4E8E 2 \u500D" },
    { id: "current_ratio_low", observationKind: "current_ratio", frequency: "quarterly", operator: "lt", threshold: 1, severity: "high", title: "\u6D41\u52A8\u6BD4\u7387\u4F4E\u4E8E 1 \u500D" },
    { id: "quick_ratio_low", observationKind: "quick_ratio", frequency: "quarterly", operator: "lt", threshold: 0.7, severity: "medium", title: "\u901F\u52A8\u6BD4\u7387\u4F4E\u4E8E 0.7 \u500D" },
    { id: "cash_conversion_cycle_lengthening", observationKind: "cash_conversion_cycle", frequency: "quarterly", operator: "delta_gt", threshold: 15, severity: "medium", title: "\u73B0\u91D1\u8F6C\u6362\u5468\u671F\u8F83\u4E0A\u671F\u5EF6\u957F\u8D85\u8FC7 15 \u5929" },
    { id: "roic_contraction", observationKind: "return_on_invested_capital", frequency: "ttm", operator: "delta_lt", threshold: -5, severity: "medium", title: "TTM ROIC \u8F83\u4E0A\u671F\u4E0B\u964D\u8D85\u8FC7 5 \u4E2A\u767E\u5206\u70B9" },
    { id: "dilution_accelerating", observationKind: "net_dilution_rate", frequency: "annual", operator: "gt", threshold: 3, severity: "medium", title: "\u7A00\u91CA\u540E\u80A1\u6570\u5E74\u589E\u5E45\u8D85\u8FC7 3%" }
  ]
};

// src/modules/research/domain/financial-analysis.ts
var FINANCIAL_ANALYSIS_PROTOCOL_VERSION = "financial-analysis-input.v1";
var FINANCIAL_ANALYSIS_CODE_VERSION = "financial-analysis-code.v7";
var coreMetrics = /* @__PURE__ */ new Set([
  "revenue",
  "gross_profit",
  "cost_of_revenue",
  "operating_profit",
  "net_profit",
  "operating_cash_flow",
  "capital_expenditure",
  "cash",
  "total_debt",
  "total_equity",
  "total_assets",
  "current_assets",
  "current_liabilities",
  "trade_receivables",
  "contract_assets",
  "inventory",
  "trade_payables",
  "short_term_debt",
  "long_term_debt",
  "lease_liabilities",
  "interest_expense",
  "dividends_paid",
  "share_repurchases",
  "share_issuance",
  "acquisition_spend",
  "diluted_weighted_average_shares",
  "diluted_shares"
]);
var coreObservationKinds = /* @__PURE__ */ new Set([
  "yoy",
  "qoq",
  "cagr",
  "gross_margin",
  "operating_margin",
  "net_margin",
  "free_cash_flow",
  "free_cash_flow_margin",
  "cash_conversion",
  "net_debt",
  "working_capital",
  "working_capital_to_revenue",
  "receivables_to_revenue",
  "inventory_to_revenue",
  "payables_to_revenue",
  "days_sales_outstanding",
  "days_inventory_outstanding",
  "days_payables_outstanding",
  "cash_conversion_cycle",
  "current_ratio",
  "quick_ratio",
  "debt_to_equity",
  "interest_coverage",
  "nopat",
  "invested_capital",
  "return_on_equity",
  "return_on_invested_capital",
  "incremental_roic",
  "net_dilution_rate",
  "net_profit_per_share",
  "free_cash_flow_per_share",
  "capital_expenditure_to_revenue",
  "net_equity_distribution"
]);
var riskRules = research_financial_analysis_risk_rules_default.rules;
function buildFinancialAnalysisSnapshot(input) {
  const allSeries = input.quality.series.filter((series) => coreMetrics.has(series.metric));
  const allObservations = [...input.quality.trends, ...input.quality.observations];
  const annual = periods(allSeries, "annual", 5);
  const quarterly = periods(allSeries, "quarterly", 8);
  const ttmEndDate = latestPeriodEndDate(allSeries, "ttm");
  const reportedFacts = allSeries.filter((series) => series.frequency === "annual" || series.frequency === "quarterly").map((series) => ({
    metric: series.metric,
    frequency: series.frequency,
    basisId: series.basis.id,
    unit: series.unit,
    points: selectSeriesPoints(series, series.frequency === "annual" ? 5 : 8).map(projectPoint)
  }));
  const observations = allObservations.filter((item) => coreObservationKinds.has(item.kind)).filter((item) => item.frequency === "annual" || item.frequency === "quarterly" || item.frequency === "ttm").filter((item) => withinLatestPeriods(item, annual, quarterly, ttmEndDate)).map(projectObservation);
  const flags = buildFinancialAnalysisRiskFlags(allObservations);
  const factIds = [.../* @__PURE__ */ new Set([...reportedFacts.flatMap((item) => item.points.flatMap((point) => point.factIds)), ...observations.flatMap((item) => item.factIds)])].sort();
  const sourceIds = [...new Set(input.quality.series.flatMap((series) => series.points.flatMap((point) => point.inputs.map((reference) => reference.provenance.sourceId))))].sort();
  const basis = {
    schemaVersion: FINANCIAL_ANALYSIS_PROTOCOL_VERSION,
    codeVersion: FINANCIAL_ANALYSIS_CODE_VERSION,
    securityCode: input.securityCode,
    asOf: latestPeriodEndDate(allSeries, "quarterly") ?? latestPeriodEndDate(allSeries, "annual") ?? "unknown",
    entityType: input.entityType,
    dataQuality: {
      status: input.availability === "source_error" || !reportedFacts.length ? "blocked" : input.availability,
      sourcePolicy: input.sourcePolicy,
      statutoryVerification: { status: input.statutoryGate.status, verifiedMetrics: input.statutoryGate.verifiedMetrics, reason: input.statutoryGate.reason },
      statements: input.statements,
      gaps: input.quality.gaps.slice(0, 120)
    },
    periodCoverage: { annual, quarterly, ttmEndDate },
    reportedFacts,
    derivedObservations: observations,
    deterministicFlags: flags,
    lineage: { factIds, sourceIds, inputFingerprint: "" }
  };
  basis.lineage.inputFingerprint = stableFingerprint({ ...basis, lineage: { ...basis.lineage, inputFingerprint: void 0 } });
  return basis;
}
function buildFinancialAnalysisRiskFlags(observations) {
  const flags = [];
  for (const rule of riskRules) {
    const candidates = observations.filter((item) => item.kind === rule.observationKind && item.frequency === rule.frequency && (!rule.metric || item.metric === rule.metric) && item.status === "available" && typeof item.value === "number");
    const latest = candidates.sort(compareObservation).at(-1);
    if (!latest || latest.value === null) continue;
    const prior = rule.operator.startsWith("delta_") ? candidates.filter((item) => compareObservation(item, latest) < 0).sort(compareObservation).at(-1) : void 0;
    const measured = prior?.value !== null && prior?.value !== void 0 ? latest.value - prior.value : latest.value;
    const triggered = rule.operator === "lt" ? measured < rule.threshold : rule.operator === "gt" ? measured > rule.threshold : rule.operator === "delta_lt" ? Boolean(prior) && measured < rule.threshold : Boolean(prior) && measured > rule.threshold;
    if (!triggered) continue;
    flags.push({ ruleId: rule.id, severity: rule.severity, title: rule.title, observationId: latest.id, period: periodLabel(latest.period), value: measured, unit: latest.unit, threshold: rule.threshold, operator: rule.operator, ...prior ? { comparisonObservationId: prior.id } : {} });
  }
  return flags.sort((left, right) => left.severity === right.severity ? left.ruleId.localeCompare(right.ruleId) : left.severity === "high" ? -1 : 1);
}
function financialAnalysisPrompt(snapshot) {
  return RESEARCH_FINANCIAL_ANALYSIS_PROMPT.replace("{{INPUT_DATA}}", JSON.stringify(projectFinancialAnalysisPromptInput(snapshot)));
}
function assertFinancialAnalysisSnapshotCanRun(snapshot) {
  if (snapshot.dataQuality.status !== "blocked") return;
  const unavailable = snapshot.dataQuality.statements.filter((item) => item && typeof item === "object" && !Array.isArray(item)).map((item) => item).filter((item) => Number(item.rows ?? 0) <= 0 || item.sourceHealth && typeof item.sourceHealth === "object" && item.sourceHealth.status === "failed").map((item) => String(item.statementType ?? "unknown"));
  throw new Error(`financial analysis is blocked until all primary statements are available${unavailable.length ? `: ${unavailable.join(", ")}` : ""}`);
}
function projectFinancialAnalysisPromptInput(snapshot) {
  const flagObservationIds = new Set(snapshot.deterministicFlags.flatMap((flag) => [flag.observationId, flag.comparisonObservationId].filter(Boolean)));
  const latestBySeries = /* @__PURE__ */ new Map();
  for (const observation of [...snapshot.derivedObservations].sort(compareProjectedObservation)) {
    const key = `${observation.kind}:${observation.metric}:${observation.frequency}`;
    latestBySeries.set(key, (latestBySeries.get(key) ?? 0) + 1);
  }
  const promptObservations = snapshot.derivedObservations.filter((item) => item.status === "available").sort(compareProjectedObservation).filter((item) => {
    const key = `${item.kind}:${item.metric}:${item.frequency}`;
    const rank = latestBySeries.get(key) ?? 0;
    latestBySeries.set(key, rank - 1);
    return rank <= 2 || flagObservationIds.has(item.id);
  });
  const compactReportedFactTables = buildReportedFactTables(snapshot.reportedFacts);
  const compactObservationTables = buildObservationTables(promptObservations);
  return {
    securityCode: snapshot.securityCode,
    asOf: snapshot.asOf,
    dataQuality: {
      status: snapshot.dataQuality.status,
      statements: snapshot.dataQuality.statements.map(compactStatementHealth),
      gapSummary: summarizeGaps(snapshot.dataQuality.gaps)
    },
    periodCoverage: snapshot.periodCoverage,
    reportedFactTables: compactReportedFactTables,
    observationTables: compactObservationTables,
    analysisBrief: buildAnalysisBrief(compactReportedFactTables, compactObservationTables),
    deterministicFlags: snapshot.deterministicFlags.map(compactRiskFlag),
    numericDisplay: { amountUnit: "\u4EBF\u5143", shareUnit: "\u4EBF\u80A1", percentageDecimals: 2 }
  };
}
var annualPromptMetrics = /* @__PURE__ */ new Set(["revenue", "gross_profit", "operating_profit", "net_profit", "operating_cash_flow", "capital_expenditure", "diluted_weighted_average_shares"]);
var quarterlyFlowPromptMetrics = /* @__PURE__ */ new Set(["revenue", "gross_profit", "operating_profit", "net_profit", "operating_cash_flow", "capital_expenditure"]);
var quarterlyBalancePromptMetrics = /* @__PURE__ */ new Set(["cash", "total_debt", "total_equity", "current_assets", "current_liabilities", "trade_receivables", "inventory", "trade_payables", "diluted_shares"]);
function buildReportedFactTables(reportedFacts) {
  const annual = buildReportedFactTable(reportedFacts, "annual");
  const quarterly = buildReportedFactTable(reportedFacts, "quarterly");
  return {
    ...annual ? { annual } : {},
    ...quarterly ? { quarterly } : {}
  };
}
function buildReportedFactTable(reportedFacts, frequency) {
  const rows = reportedFacts.filter((series) => series.frequency === frequency).flatMap((series) => projectPromptFactRow(series)).sort((left, right) => left.metric.localeCompare(right.metric));
  if (!rows.length) return null;
  const periods2 = [...new Set(rows.flatMap((row) => row.periods))].sort();
  const compactRows = rows.map((row) => ({ metric: row.metric, unit: row.unit, values: periods2.map((period) => row.valuesByPeriod.get(period) ?? null) })).filter((row) => row.values.some((value) => value !== null));
  return compactRows.length ? { periods: periods2, rows: compactRows } : null;
}
function projectPromptFactRow(series) {
  const metricAllowed = series.frequency === "annual" ? annualPromptMetrics.has(series.metric) : quarterlyFlowPromptMetrics.has(series.metric) || quarterlyBalancePromptMetrics.has(series.metric);
  if (!metricAllowed) return [];
  const limit = series.frequency === "quarterly" && quarterlyBalancePromptMetrics.has(series.metric) ? 2 : 8;
  const points = series.points.slice(-limit);
  const valuesByPeriod = new Map(points.map((point) => [point.period, compactPromptValue(point.value, series.unit)]));
  return valuesByPeriod.size ? [{ metric: series.metric, unit: compactPromptUnit(series.unit), periods: points.map((point) => point.period), valuesByPeriod }] : [];
}
function buildObservationTables(observations) {
  const annual = buildObservationTable(observations, "annual");
  const quarterly = buildObservationTable(observations, "quarterly");
  const ttm = buildObservationTable(observations, "ttm");
  return {
    ...annual ? { annual } : {},
    ...quarterly ? { quarterly } : {},
    ...ttm ? { ttm } : {}
  };
}
function buildObservationTable(observations, frequency) {
  const selected = observations.filter((item) => item.frequency === frequency);
  if (!selected.length) return null;
  const periods2 = [...new Set(selected.map((item) => item.period))].sort();
  const grouped = /* @__PURE__ */ new Map();
  for (const item of selected) {
    const key = `${item.kind}:${item.metric}:${item.unit}`;
    const existing = grouped.get(key) ?? {
      kind: item.kind,
      metric: item.metric,
      unit: compactPromptUnit(item.unit),
      valuesByPeriod: /* @__PURE__ */ new Map(),
      comparisonsByPeriod: /* @__PURE__ */ new Map()
    };
    existing.valuesByPeriod.set(item.period, compactPromptValue(item.value, item.unit));
    existing.comparisonsByPeriod.set(item.period, item.comparisonPeriod);
    grouped.set(key, existing);
  }
  const rows = [...grouped.values()].sort((left, right) => left.metric.localeCompare(right.metric) || left.kind.localeCompare(right.kind)).map((row) => {
    const comparisonPeriods = periods2.map((period) => row.comparisonsByPeriod.get(period) ?? null);
    return {
      kind: row.kind,
      metric: row.metric,
      ...comparisonPeriods.some((period) => period !== null) ? { comparisonPeriods } : {},
      values: periods2.map((period) => row.valuesByPeriod.get(period) ?? null),
      unit: row.unit
    };
  }).filter((row) => row.values.some((value) => value !== null));
  return rows.length ? { periods: periods2, rows } : null;
}
var metricBriefConfigs = [
  { section: "growth_profitability", metric: "revenue" },
  { section: "growth_profitability", metric: "gross_profit" },
  { section: "growth_profitability", metric: "operating_profit" },
  { section: "growth_profitability", metric: "net_profit" },
  { section: "cash_working_capital", metric: "operating_cash_flow" },
  { section: "cash_working_capital", metric: "inventory" },
  { section: "cash_working_capital", metric: "trade_receivables" },
  { section: "cash_working_capital", metric: "trade_payables" },
  { section: "capital_efficiency", metric: "capital_expenditure" },
  { section: "balance_sheet", metric: "cash" },
  { section: "balance_sheet", metric: "total_debt" },
  { section: "balance_sheet", metric: "total_equity" },
  { section: "per_share", metric: "diluted_weighted_average_shares" },
  { section: "per_share", metric: "diluted_shares" }
];
var observationBriefConfigs = [
  { section: "growth_profitability", kind: "gross_margin", metric: "gross_profit" },
  { section: "growth_profitability", kind: "operating_margin", metric: "operating_profit" },
  { section: "growth_profitability", kind: "net_margin", metric: "net_profit" },
  { section: "cash_working_capital", kind: "free_cash_flow", metric: "free_cash_flow" },
  { section: "cash_working_capital", kind: "cash_conversion", metric: "operating_cash_flow" },
  { section: "cash_working_capital", kind: "receivables_to_revenue", metric: "trade_receivables" },
  { section: "cash_working_capital", kind: "inventory_to_revenue", metric: "inventory" },
  { section: "cash_working_capital", kind: "payables_to_revenue", metric: "trade_payables" },
  { section: "capital_efficiency", kind: "capital_expenditure_to_revenue", metric: "capital_expenditure" },
  { section: "capital_efficiency", kind: "return_on_equity", metric: "total_equity" },
  { section: "capital_efficiency", kind: "return_on_invested_capital", metric: "invested_capital" },
  { section: "balance_sheet", kind: "current_ratio", metric: "current_assets" },
  { section: "balance_sheet", kind: "quick_ratio", metric: "current_assets" },
  { section: "balance_sheet", kind: "debt_to_equity", metric: "total_debt" },
  { section: "per_share", kind: "net_profit_per_share", metric: "net_profit" },
  { section: "per_share", kind: "free_cash_flow_per_share", metric: "free_cash_flow" },
  { section: "per_share", kind: "book_value_per_share", metric: "total_equity" },
  { section: "per_share", kind: "net_dilution_rate", metric: "diluted_shares" }
];
function buildAnalysisBrief(reportedFactTables, observationTables) {
  const metricBriefs = metricBriefConfigs.map(({ section, metric }) => buildMetricBrief(section, metric, reportedFactTables, observationTables)).filter(Boolean);
  const observationBriefs = observationBriefConfigs.map(({ section, kind, metric }) => buildObservationBrief(section, kind, metric, observationTables)).filter(Boolean);
  return {
    writingPolicy: {
      focus: "\u4F18\u5148\u5F15\u7528\u672C\u6458\u8981\u4E2D\u7684\u6700\u65B0\u5E74\u5EA6\u3001\u6700\u65B0\u5B63\u5EA6\u3001\u540C\u6BD4/\u73AF\u6BD4\u548C\u5173\u952E\u89C2\u5BDF\uFF0C\u518D\u7ED9\u51FA\u89E3\u91CA\u3001\u53CD\u8BC1\u3001\u9650\u5236\u548C\u9A8C\u8BC1\u9879\u3002",
      avoid: "\u4E0D\u8981\u6309\u8868\u683C\u987A\u5E8F\u628A\u6240\u6709\u671F\u95F4\u548C\u6307\u6807\u9010\u9879\u91CD\u6284\u6210\u6B63\u6587\uFF1B\u53EA\u4FDD\u7559\u652F\u6491\u5224\u65AD\u6240\u9700\u7684\u5173\u952E\u6570\u5B57\u3002"
    },
    metricBriefs,
    observationBriefs
  };
}
function buildMetricBrief(section, metric, reportedFactTables, observationTables) {
  const annualSeries = reportedFactTables.annual?.rows.find((item) => item.metric === metric) ?? null;
  const quarterlySeries = reportedFactTables.quarterly?.rows.find((item) => item.metric === metric) ?? null;
  if (!annualSeries && !quarterlySeries) return null;
  return {
    section,
    metric,
    ...annualSeries && reportedFactTables.annual ? { latestAnnual: summarizeMetricSeries(metric, "annual", reportedFactTables.annual.periods, annualSeries, observationTables) } : {},
    ...quarterlySeries && reportedFactTables.quarterly ? { latestQuarter: summarizeMetricSeries(metric, "quarterly", reportedFactTables.quarterly.periods, quarterlySeries, observationTables) } : {}
  };
}
function summarizeMetricSeries(metric, frequency, periods2, row, observationTables) {
  const latestIndex = latestValueIndex(row.values);
  if (latestIndex === -1) return null;
  const latestPeriod = periods2[latestIndex];
  const latestValue = row.values[latestIndex];
  const yoyObservation = findObservation(observationTables, "yoy", metric, frequency, latestPeriod);
  const qoqObservation = findObservation(observationTables, "qoq", metric, frequency, latestPeriod);
  const cagrObservation = findObservation(observationTables, "cagr", metric, frequency, latestPeriod);
  const previous = valueByPeriod(periods2, row.values, frequency === "quarterly" ? qoqObservation?.comparisonPeriod ?? null : yoyObservation?.comparisonPeriod ?? null);
  const previousYear = frequency === "quarterly" ? valueByPeriod(periods2, row.values, yoyObservation?.comparisonPeriod ?? null) : null;
  return {
    period: latestPeriod,
    value: latestValue,
    ...previous ? { previousPeriod: previous.period, previousValue: previous.value } : {},
    ...previousYear ? { previousYearPeriod: previousYear.period, previousYearValue: previousYear.value } : {},
    ...yoyObservation ? { yoy: yoyObservation.value } : {},
    ...qoqObservation ? { qoq: qoqObservation.value } : {},
    ...cagrObservation ? { cagr: cagrObservation.value } : {}
  };
}
function buildObservationBrief(section, kind, metric, observationTables) {
  const latestAnnual = latestObservation(observationTables, kind, metric, "annual");
  const latestQuarter = latestObservation(observationTables, kind, metric, "quarterly");
  const latestTtm = latestObservation(observationTables, kind, metric, "ttm");
  if (!latestAnnual && !latestQuarter && !latestTtm) return null;
  return {
    section,
    kind,
    metric,
    ...latestAnnual ? { latestAnnual } : {},
    ...latestQuarter ? { latestQuarter } : {},
    ...latestTtm ? { latestTtm } : {}
  };
}
function latestObservation(observationTables, kind, metric, frequency) {
  const table = observationTables[frequency];
  const row = table?.rows.find((item) => item.kind === kind && item.metric === metric);
  if (!table || !row) return null;
  const latestIndex = latestValueIndex(row.values);
  if (latestIndex === -1) return null;
  return {
    period: table.periods[latestIndex],
    ...row.comparisonPeriods ? { comparisonPeriod: row.comparisonPeriods[latestIndex] ?? null } : {},
    value: row.values[latestIndex],
    unit: row.unit
  };
}
function findObservation(observationTables, kind, metric, frequency, period) {
  const table = observationTables[frequency];
  const row = table?.rows.find((item) => item.kind === kind && item.metric === metric);
  if (!table || !row) return null;
  const index = table.periods.indexOf(period);
  if (index === -1) return null;
  const value = row.values[index];
  return value === null || value === void 0 ? null : {
    period,
    comparisonPeriod: row.comparisonPeriods?.[index] ?? null,
    value
  };
}
function latestValueIndex(values2) {
  for (let index = values2.length - 1; index >= 0; index -= 1) {
    if (values2[index] !== null) return index;
  }
  return -1;
}
function valueByPeriod(periods2, values2, period) {
  if (!period) return null;
  const index = periods2.indexOf(period);
  if (index === -1) return null;
  const value = values2[index];
  return value === null || value === void 0 ? null : { period, value };
}
function compactStatementHealth(value) {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceHealth = item.sourceHealth && typeof item.sourceHealth === "object" && !Array.isArray(item.sourceHealth) ? item.sourceHealth : {};
  return { statementType: item.statementType ?? null, rows: item.rows ?? 0, originProviders: item.originProviders ?? [], reportingCurrencies: item.reportingCurrencies ?? [], latestReportDate: item.latestReportDate ?? null, sourceHealth: sourceHealth.status ?? "unknown" };
}
function compactRiskFlag(flag) {
  return { ruleId: flag.ruleId, severity: flag.severity, title: flag.title, period: flag.period, ...compactPromptNumber(flag.value, flag.unit), threshold: compactPromptValue(flag.threshold, flag.unit), unit: compactPromptUnit(flag.unit), operator: flag.operator };
}
function compactPromptNumber(value, unit) {
  return { value: compactPromptValue(value, unit), unit: compactPromptUnit(unit) };
}
function compactPromptValue(value, unit) {
  if (value === null) return null;
  const divisor = unit === "CNY" || unit === "shares" ? 1e8 : 1;
  const decimals = unit === "CNY" || unit === "shares" || unit === "percent" ? 2 : 4;
  return Number((value / divisor).toFixed(decimals));
}
function compactPromptUnit(unit) {
  if (unit === "CNY") return "\u4EBF\u5143";
  if (unit === "shares") return "\u4EBF\u80A1";
  return unit;
}
function compareProjectedObservation(left, right) {
  return left.period.localeCompare(right.period) || left.id.localeCompare(right.id);
}
function summarizeGaps(gaps) {
  const counts = /* @__PURE__ */ new Map();
  for (const gap of gaps) {
    const record3 = gap && typeof gap === "object" && !Array.isArray(gap) ? gap : {};
    const status = typeof record3.status === "string" ? record3.status : "unknown";
    const reason = Array.isArray(record3.reasonCodes) ? record3.reasonCodes.filter((item) => typeof item === "string").sort().join(",") : "unspecified";
    const key = `${status}:${reason || "unspecified"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => ({ key, count }));
}
function selectSeriesPoints(series, limit) {
  return [...series.points].sort((left, right) => comparePeriod2(left.period, right.period)).slice(-limit);
}
function projectPoint(point) {
  return { period: periodLabel(point.period), status: point.status, value: point.value, formula: point.formula, reasonCodes: point.reasonCodes, factIds: point.inputs.map((reference) => reference.factId), sources: projectSources(point.inputs) };
}
function projectObservation(item) {
  return { id: item.id, kind: item.kind, metric: item.metric, frequency: item.frequency, period: periodLabel(item.period), comparisonPeriod: item.comparisonPeriod ? periodLabel(item.comparisonPeriod) : null, status: item.status, value: item.value, unit: item.unit, formula: item.formula, reasonCodes: item.reasonCodes, factIds: item.inputs.map((reference) => reference.factId), sources: projectSources(item.inputs) };
}
function projectSources(inputs) {
  const seen = /* @__PURE__ */ new Set();
  return inputs.flatMap(({ provenance }) => {
    const key = `${provenance.sourceId}:${provenance.locator ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...provenance }];
  });
}
function periods(series, frequency, limit) {
  return [...new Set(series.filter((item) => item.frequency === frequency).flatMap((item) => item.points.map((point) => periodLabel(point.period))))].sort().slice(-limit);
}
function withinLatestPeriods(item, annual, quarterly, ttmEndDate) {
  return item.frequency === "annual" ? annual.includes(periodLabel(item.period)) : item.frequency === "quarterly" ? quarterly.includes(periodLabel(item.period)) : item.frequency === "ttm" ? item.period.endDate === ttmEndDate : false;
}
function comparePeriod2(left, right) {
  return left.endDate.localeCompare(right.endDate) || left.fiscalYear - right.fiscalYear || (left.fiscalQuarter ?? 0) - (right.fiscalQuarter ?? 0);
}
function compareObservation(left, right) {
  return comparePeriod2(left.period, right.period) || left.id.localeCompare(right.id);
}
function periodLabel(period) {
  return period.kind === "quarter" ? `${period.fiscalYear}Q${period.fiscalQuarter}` : period.kind === "annual" ? `FY${period.fiscalYear}` : period.endDate;
}
function latestPeriodEndDate(series, frequency) {
  return series.filter((item) => item.frequency === frequency).flatMap((item) => item.points.map((point) => point.period.endDate)).sort().at(-1) ?? null;
}
function stableFingerprint(value) {
  const text6 = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text6.length; index += 1) {
    hash ^= text6.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}`;
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record3 = value;
  return `{${Object.keys(record3).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record3[key])}`).join(",")}}`;
}

// src/modules/research/application/research-financial-analysis.ts
var MODEL = "gpt-5.6-luna";
var DEFAULT_REASONING_EFFORT = "xhigh";
var TASK_TYPE = "webqa.chatgpt.v1";
var FINANCIAL_ANALYSIS_NAMESPACE = "research_financial_analysis";
function researchFinancialAnalysisTaskName(securityCode) {
  return `research:financial-analysis:${securityCode.trim().toUpperCase()}`;
}
async function enqueueResearchFinancialAnalysis(env, securityCode, options = {}) {
  const prepared = await prepareResearchFinancialAnalysis(env, securityCode);
  const current = await loadResult(env.DB, prepared.snapshot.securityCode);
  const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
  const name = researchFinancialAnalysisTaskName(prepared.snapshot.securityCode);
  const task = await taskdCallerClient(env).submit({
    name,
    taskType: TASK_TYPE,
    payload: {
      ...taskdWebQaInput(env, { model: MODEL, reasoningEffort, waitTimeoutMs: 60 * 6e4, messages: [{ role: "user", content: prepared.prompt }] }, name),
      // taskd retains this exact input; the executor intentionally ignores it.
      business_input: prepared.snapshot
    },
    diagnostics: { securityCode: prepared.snapshot.securityCode, model: MODEL, reasoningEffort, promptVersion: prepared.snapshot.codeVersion, schemaVersion: prepared.snapshot.schemaVersion }
  });
  await storeResult(env.DB, prepared.snapshot.securityCode, mergeStoredResult(current, { snapshotJson: JSON.stringify(prepared.snapshot), task: taskView(task) }));
  return { accepted: true, task: taskView(task), snapshot: prepared.snapshot, force: options.force === true };
}
async function loadResearchFinancialAnalysis(env, securityCode) {
  const code = securityCode.trim().toUpperCase();
  let result = await loadResult(env.DB, code);
  if (result?.markdown && !isPendingTask(result.task)) return responseFromStoredResult(result);
  let task = result?.task ?? null;
  if (env.LLM_RUNTIME === "local" && result && task && !result.markdown) {
    const state = await reconcileTaskdResult(taskdCallerClient(env), {
      name: task.name,
      project: async (currentTask) => {
        const snapshot = taskBusinessSnapshot(currentTask) ?? snapshotFromJson(result?.snapshotJson);
        if (!snapshot) throw new Error("financial analysis task has no frozen input snapshot");
        return projectResearchFinancialAnalysis(env, snapshot, currentTask);
      }
    });
    try {
      switch (state.state) {
        case "projected":
          result = state.value;
          task = state.value.task;
          break;
        case "pending":
        case "failed":
        case "interrupted":
        case "superseded":
          task = taskView(state.task);
          result = await persistTaskSnapshot(env.DB, code, result, taskBusinessSnapshot(state.task) ?? snapshotFromJson(result?.snapshotJson), state.task, null);
          break;
        case "missing":
          task = null;
          if (result?.task) result = await persistTaskSnapshot(env.DB, code, result, snapshotFromJson(result.snapshotJson), null, "taskd no longer has the recorded financial-analysis task");
          break;
      }
    } catch (error) {
      const message2 = error instanceof Error ? error.message : String(error);
      result = await persistTaskSnapshot(env.DB, code, result, snapshotFromJson(result.snapshotJson), task, message2);
    }
  }
  if (result) return responseFromStoredResult(result);
  return { availability: task?.status === "failed" ? "failed" : task ? "pending" : "empty", task, snapshot: null, report: null, resume: { available: task?.status === "failed", reason: task?.status === "failed" ? "submit_new_task" : "not_failed" } };
}
async function resumeResearchFinancialAnalysis(env, securityCode) {
  const code = securityCode.trim().toUpperCase();
  const stored = await loadResult(env.DB, code);
  if (!stored?.task) throw new Error("financial analysis has no recorded task to recover");
  if (env.LLM_RUNTIME !== "local") throw new Error("financial analysis recovery is only available in local LLM runtime");
  const client = taskdCallerClient(env);
  let remote = await client.get(stored.task.name);
  if (remote && isTerminalTask(remote) && hasRecoverableProviderSubmission(remote.checkpoint)) {
    remote = await client.recover(stored.task.name);
  }
  if (!remote) {
    await persistTaskSnapshot(env.DB, code, stored, snapshotFromJson(stored.snapshotJson), null, "taskd no longer has the recorded financial-analysis task");
  } else {
    await persistTaskSnapshot(env.DB, code, stored, taskBusinessSnapshot(remote) ?? snapshotFromJson(stored.snapshotJson), remote, null);
  }
  return loadResearchFinancialAnalysis(env, code);
}
async function prepareResearchFinancialAnalysis(env, securityCode) {
  const { security, loaded, facts, sourceErrors, primaryAvailable } = await loadResearchFinancialFactSet(env, securityCode);
  const availability = sourceErrors.length ? "source_error" : primaryAvailable ? "available" : "partial";
  const snapshot = buildFinancialAnalysisSnapshot({
    securityCode: security.code,
    // This task's prompt is built only from request-time primary finance APIs.
    // A security code cannot establish whether the issuer is a financial entity.
    entityType: "unknown",
    sourcePolicy: financialAnalysisSourcePolicy(security.market),
    availability,
    statutoryGate: { status: "not_loaded", verifiedMetrics: [], reason: "\u672C\u4EFB\u52A1\u4EC5\u51BB\u7ED3\u4E3B\u8D22\u62A5\u63A5\u53E3\u6570\u636E\uFF1B\u6CD5\u5B9A\u62AB\u9732\u6838\u9A8C\u660E\u7EC6\u4E0D\u5C5E\u4E8E taskd \u8D22\u52A1\u5206\u6790\u7684\u524D\u7F6E\u8F93\u5165\u3002" },
    statements: loaded.map(({ statementType, result, error }) => ({
      statementType,
      rows: result.rows.length,
      source: result.delivery?.cache ?? "source_error",
      originProviders: result.delivery?.originProviders ?? [],
      reportingCurrencies: result.reportingCurrencies,
      latestReportDate: result.latestReportDate,
      sourceHealth: result.sourceHealth,
      error
    })),
    quality: buildResearchFinancialQuality({ facts, entityType: "unknown" })
  });
  assertFinancialAnalysisSnapshotCanRun(snapshot);
  return { snapshot, prompt: financialAnalysisPrompt(snapshot) };
}
function financialAnalysisSourcePolicy(market) {
  return market === "us_share" ? "Yahoo \u4E3B\u8D22\u62A5\uFF08\u672C\u5730\u7ECF\u914D\u7F6E\u4EE3\u7406\uFF1B\u751F\u4EA7\u7EDF\u4E00 HTTP\uFF1B\u65E0\u81EA\u52A8\u56DE\u9000\uFF09" : market === "h_share" ? "Eastmoney HK F10 \u4E3B\u8D22\u62A5\uFF08\u65E0\u81EA\u52A8\u56DE\u9000\uFF09" : "Eastmoney \u4E3B\u8D22\u62A5\uFF08\u65E0\u81EA\u52A8\u56DE\u9000\uFF09";
}
async function projectResearchFinancialAnalysis(env, snapshot, task) {
  const result = extractTaskdWebQaResult(task.result);
  const markdown = text4(result.content.markdown);
  validateFinancialMarkdown(markdown);
  const stored = {
    snapshotJson: JSON.stringify(snapshot),
    markdown,
    citationsJson: JSON.stringify(result.citations),
    sourcesJson: JSON.stringify(result.sources),
    terminalEvidenceJson: JSON.stringify(result.terminalEvidence),
    projectedAt: Date.now(),
    projectionError: null,
    task: taskView(task)
  };
  await storeResult(env.DB, snapshot.securityCode, stored);
  return { securityCode: snapshot.securityCode, ...stored };
}
async function loadResult(db, securityCode) {
  const value = await readStoredResearchFinancialAnalysis(db, securityCode);
  return value ? { securityCode, ...value } : null;
}
async function readStoredResearchFinancialAnalysis(db, securityCode) {
  const row = await getKvCache(db, FINANCIAL_ANALYSIS_NAMESPACE, securityCode.trim().toUpperCase());
  const parsed = object(parseJson(row?.valueJson ?? null));
  if (!parsed) return null;
  const task = parseStoredTask(parsed.task);
  const snapshotJson = typeof parsed.snapshotJson === "string" ? parsed.snapshotJson : null;
  const markdown = text4(parsed.markdown) || null;
  const projectedAt = parsed.projectedAt === null || parsed.projectedAt === void 0 ? null : Number(parsed.projectedAt);
  if (!snapshotJson && !markdown && !task) return null;
  return { snapshotJson, markdown, citationsJson: jsonString(parsed.citationsJson, "[]"), sourcesJson: jsonString(parsed.sourcesJson, "[]"), terminalEvidenceJson: nullableJsonString(parsed.terminalEvidenceJson), projectedAt: Number.isFinite(projectedAt) ? projectedAt : null, projectionError: text4(parsed.projectionError) || null, task };
}
async function persistTaskSnapshot(db, securityCode, current, snapshot, task, projectionError) {
  const stored = mergeStoredResult(current, { snapshotJson: snapshot ? JSON.stringify(snapshot) : void 0, task: task ? taskView(task) : null, projectionError });
  await storeResult(db, securityCode, stored);
  return { securityCode, ...stored };
}
async function storeResult(db, securityCode, value) {
  await putKvCache(db, { namespace: FINANCIAL_ANALYSIS_NAMESPACE, key: securityCode.trim().toUpperCase(), valueJson: JSON.stringify(value), expiresAt: null, updatedAt: value.projectedAt ?? value.task?.updatedAt ?? Date.now() });
}
function responseFromStoredResult(result) {
  const snapshot = snapshotFromJson(result.snapshotJson);
  return {
    availability: result.markdown ? "available" : result.projectionError || isTerminalTask(result.task) ? "failed" : result.task ? "pending" : "empty",
    task: result.task,
    snapshot,
    report: result.markdown ? { markdown: result.markdown, citations: parseArray(result.citationsJson), sources: parseArray(result.sourcesJson), terminalMetadata: parseJson(result.terminalEvidenceJson), projectedAt: result.projectedAt } : null,
    resume: { available: !result.markdown && Boolean(result.task), reason: result.markdown ? "already_projected" : result.projectionError ? "retry_projection_only" : isTerminalTask(result.task) ? "inspect_existing_task_only" : "observe_existing_task_only" }
  };
}
function mergeStoredResult(current, patch) {
  return {
    snapshotJson: patch.snapshotJson !== void 0 ? patch.snapshotJson : current?.snapshotJson ?? null,
    markdown: patch.markdown !== void 0 ? patch.markdown : current?.markdown ?? null,
    citationsJson: patch.citationsJson ?? current?.citationsJson ?? "[]",
    sourcesJson: patch.sourcesJson ?? current?.sourcesJson ?? "[]",
    terminalEvidenceJson: patch.terminalEvidenceJson !== void 0 ? patch.terminalEvidenceJson : current?.terminalEvidenceJson ?? null,
    projectedAt: patch.projectedAt !== void 0 ? patch.projectedAt : current?.projectedAt ?? null,
    projectionError: patch.projectionError !== void 0 ? patch.projectionError : current?.projectionError ?? null,
    task: patch.task !== void 0 ? patch.task : current?.task ?? null
  };
}
function taskBusinessSnapshot(task) {
  return snapshotFromValue(object(task.input)?.business_input);
}
function hasRecoverableProviderSubmission(value) {
  const checkpoint = object(value);
  if (text4(checkpoint?.provider_url)) return true;
  const submission = object(checkpoint?.submission);
  if (text4(submission?.schema_version) !== "provider_submission.v1") return false;
  return Boolean(text4(submission?.marker));
}
function snapshotFromJson(value) {
  return snapshotFromValue(parseJson(value ?? null));
}
function snapshotFromValue(value) {
  const row = object(value);
  return row && text4(row.securityCode) ? row : null;
}
function parseStoredTask(value) {
  const row = object(value);
  const name = text4(row?.name);
  const status = text4(row?.status);
  const createdAt = Number(row?.createdAt);
  const updatedAt = Number(row?.updatedAt);
  if (!name || !isTaskStatus(status) || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return null;
  const completedAt = row?.completedAt === null || row?.completedAt === void 0 ? null : Number(row?.completedAt);
  const taskId = row?.taskId === null || row?.taskId === void 0 ? null : Number(row.taskId);
  return { taskId: taskId !== null && Number.isInteger(taskId) && taskId > 0 ? taskId : null, name, status, errorMessage: text4(row?.errorMessage) || null, createdAt, updatedAt, completedAt: Number.isFinite(completedAt) ? completedAt : null };
}
function taskView(task) {
  return { taskId: task.taskId ?? null, name: task.name, status: task.status, errorMessage: task.errorMessage, createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt };
}
function isPendingTask(task) {
  return task?.status === "queued" || task?.status === "leased" || task?.status === "running" || task?.status === "interrupt_requested";
}
function isTerminalTask(task) {
  return task?.status === "succeeded" || task?.status === "failed" || task?.status === "interrupted" || task?.status === "superseded";
}
function isTaskStatus(value) {
  return (/* @__PURE__ */ new Set(["queued", "leased", "running", "interrupt_requested", "succeeded", "failed", "interrupted", "superseded"])).has(value);
}
function normalizeReasoningEffort(value) {
  const normalized = text4(value) || DEFAULT_REASONING_EFFORT;
  if (!(/* @__PURE__ */ new Set(["low", "medium", "high", "xhigh"])).has(normalized)) throw new Error("unsupported financial-analysis reasoning effort");
  return normalized;
}
function validateFinancialMarkdown(markdown) {
  if (markdown.length < 800) throw new Error("financial analysis result is shorter than 800 characters");
  const headings = new Set([...markdown.matchAll(/^# ([1-8])\. /gm)].map((match2) => match2[1]));
  if (headings.size !== 8) throw new Error("financial analysis result must contain all eight numbered H1 headings");
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function text4(value) {
  return typeof value === "string" ? value.trim() : "";
}
function jsonString(value, fallback = "{}") {
  return typeof value === "string" ? value : fallback;
}
function nullableJsonString(value) {
  return typeof value === "string" ? value : null;
}
function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}
function parseArray(value) {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

// src/adapters/xueqiu.ts
var XUEQIU_KLINE_URL = "https://stock.xueqiu.com/v5/stock/chart/kline.json";
var XUEQIU_REFERER = "https://xueqiu.com/";
var XUEQIU_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
var XUEQIU_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
var XUEQIU_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7";
async function fetchXueqiuStockKline(db, code, period, fq, to, httpOptions, xueqiuCookie) {
  const normalized = normalizeSecurityCode(code);
  const symbol = xueqiuSymbol(normalized);
  if (!symbol) {
    throw new Error(`unsupported Xueqiu stock code: ${code}`);
  }
  const cookie = xueqiuCookie?.trim();
  if (!cookie) {
    throw new Error("XUEQIU_COOKIE is required for Xueqiu stock K-line requests");
  }
  const request = createXueqiuKlineRequest(symbol, period, fq, to, cookie);
  const rawResponseText = await cachedFetchText(db, request.url, {
    headers: request.headers
  }, 10 * 60 * 1e3, {
    ...httpOptions,
    cacheKey: `xueqiu:kline:v1:${normalized}:${period}:${fq}:${to}`
  });
  const body = parseJsonOrJsonp(rawResponseText);
  if (isXueqiuAuthError(body)) {
    throw new Error(`Xueqiu cookie expired or rejected: ${body.error_description ?? body.error_code}`);
  }
  const now = Date.now();
  const rows = mapXueqiuKlineRows(body, { code: normalized, period, fq, updatedAt: now });
  return { rows, rawResponseText };
}
function createXueqiuKlineRequest(symbol, period, fq, to, cookie) {
  const url = new URL(XUEQIU_KLINE_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("begin", String(Date.parse(`${to}T00:00:00.000Z`) + 864e5));
  url.searchParams.set("period", period);
  url.searchParams.set("type", xueqiuFq(fq));
  url.searchParams.set("count", "-7500");
  url.searchParams.set("indicator", "kline,pe,pb,ps,pcf,market_capital,agt,ggt,balance");
  return {
    url: url.toString(),
    headers: {
      Accept: XUEQIU_ACCEPT,
      "Accept-Language": XUEQIU_ACCEPT_LANGUAGE,
      Cookie: cookie,
      Referer: XUEQIU_REFERER,
      "User-Agent": XUEQIU_USER_AGENT,
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  };
}
function mapXueqiuKlineRows(response, context) {
  const columnIndex = new Map(
    (response.data?.column ?? []).map((column, index) => [typeof column === "string" ? column : "", index]).filter(([column]) => Boolean(column))
  );
  for (const required3 of ["timestamp", "open", "high", "low", "close"]) {
    if (!columnIndex.has(required3)) {
      throw new Error(`Xueqiu K-line response missing required column: ${required3}`);
    }
  }
  const value = (item, column) => {
    const index = columnIndex.get(column);
    return index === void 0 ? null : numberOrNull(item[index]);
  };
  return (response.data?.item ?? []).filter((item) => Array.isArray(item)).map((item) => ({
    ...context,
    date: xueqiuDate(item[columnIndex.get("timestamp")]),
    volume: value(item, "volume"),
    open: value(item, "open"),
    high: value(item, "high"),
    low: value(item, "low"),
    close: value(item, "close"),
    turnover: value(item, "turnoverrate"),
    amplitude: null,
    pctChange: value(item, "percent"),
    changeAmount: value(item, "chg"),
    amount: value(item, "amount"),
    peTtm: value(item, "pe"),
    pb: value(item, "pb"),
    ps: value(item, "ps"),
    pcf: value(item, "pcf"),
    marketCapital: value(item, "market_capital"),
    balance: value(item, "balance"),
    source: "xueqiu"
  })).filter((row) => Boolean(row.date));
}
function xueqiuSymbol(code) {
  const normalized = normalizeSecurityCode(code);
  const [base, suffix] = normalized.split(".");
  if (!base || !suffix) return null;
  if (suffix === "SZ" || suffix === "ZF") return `SZ${base}`;
  if (suffix === "SH" || suffix === "SF") return `SH${base}`;
  if (suffix === "BJ") return `BJ${base}`;
  if (suffix === "HK") return base.padStart(5, "0");
  if (["US", "O", "N", "AF"].includes(suffix)) return base;
  return null;
}
function xueqiuFq(fq) {
  if (fq === "qfq" || fq === "before") return "before";
  if (fq === "hfq" || fq === "after") return "after";
  return "normal";
}
function xueqiuDate(value) {
  const timestamp = numberOrNull(value);
  if (timestamp === null) return "";
  return new Date(timestamp + 8 * 60 * 60 * 1e3).toISOString().slice(0, 10);
}
function isXueqiuAuthError(body) {
  return String(body.error_code ?? "") === "400016" || /重新登录|登录.*失效|login/i.test(body.error_description ?? "");
}

// src/modules/market/application/load-kline.ts
async function loadKline(env, rawCode, period, fq, from, to) {
  if (period !== "day") {
    throw new Error(`unsupported kline period: ${period}`);
  }
  const code = normalizeSecurityCode(rawCode);
  if (usesFundNetValueHistory(code)) {
    const fundCode = code.endsWith(".OF") ? code : `${code.split(".")[0]}.OF`;
    const snapshot2 = await getFundNavSnapshot(env, fundCode);
    if (snapshot2 && isFreshEnough(fundCode, snapshot2.updatedAt) && snapshotCoversRequestedRange(snapshot2, from, to)) {
      return { code: fundCode, source: "r2", rows: sliceFundNavRows(snapshot2.rows, from, to) };
    }
    const historyRows = await fetchEastmoneyFundNav(env.DB, fundCode, from, to);
    return { code: fundCode, source: "eastmoney", rows: sliceFundNavRows(historyRows, from, to) };
  }
  const snapshot = await getKlineSnapshot(env, code, fq);
  if (snapshot && snapshot.schemaVersion === 2 && snapshot.source === "xueqiu" && typeof snapshot.rawResponseText === "string" && isFreshEnough(code, snapshot.updatedAt) && snapshotCoversRequestedRange(snapshot, from, to)) {
    return { code, source: "r2", rows: sliceKlineRows(snapshot.rows, from, to) };
  }
  const fetched = await fetchXueqiuStockKline(
    env.DB,
    code,
    period,
    fq,
    to,
    externalHttpOptions(env),
    env.XUEQIU_COOKIE
  );
  if (fetched.rows.length > 0) {
    await putKlineSnapshot(env, code, fq, fetched.rows, { rawResponseText: fetched.rawResponseText });
  }
  return { code, source: "xueqiu", rows: sliceKlineRows(fetched.rows, from, to) };
}
function usesFundNetValueHistory(code) {
  return /\.(OF|SF|ZF)$/.test(normalizeSecurityCode(code));
}
function isFreshEnough(code, updatedAt) {
  if (!updatedAt) {
    return false;
  }
  return Date.now() < marketDataCacheExpiresAtMsForCode(code, updatedAt);
}
function snapshotCoversRequestedRange(snapshot, from, to) {
  if (snapshotCoversRange(snapshot, from, to)) {
    return true;
  }
  return from === fullKlineHistoryStartDate() && Boolean(snapshot.startDate && snapshot.endDate && snapshot.endDate >= to);
}

// src/modules/security/application/search-securities.ts
async function getSecurity(db, code) {
  const normalized = normalizeSecurityCode(code);
  const query = normalized.split(".")[0] ?? normalized;
  const remote = await fetchEastmoneySuggest(db, query);
  return remote.find((item) => normalizeSecurityCode(item.code) === normalized) ?? null;
}

// config/research-eastmoney-em2016-industry-profiles.json
var research_eastmoney_em2016_industry_profiles_default = {
  schemaVersion: "research-eastmoney-em2016-industry-profiles.v1",
  description: "\u4E1C\u65B9\u8D22\u5BCC EM2016 \u4E09\u7EA7\u884C\u4E1A\u7684\u7EC6\u5206\u7814\u7A76\u753B\u50CF\u3002\u6BCF\u4E2A\u5DF2\u6536\u5F55\u53F6\u5B50\u884C\u4E1A\u5FC5\u987B\u547D\u4E2D\u4E00\u4E2A\u753B\u50CF\uFF1B\u753B\u50CF\u51B3\u5B9A\u5B9E\u9645\u6CE8\u5165\u6295\u8D44\u5206\u6790 prompt \u7684\u7ECF\u8425\u516C\u5F0F\u3001\u6838\u9A8C\u6307\u6807\u3001\u4F30\u503C\u65B9\u6CD5\u548C\u538B\u529B\u6D4B\u8BD5\u3002\u672A\u6765 EM2016 \u53F6\u5B50\u82E5\u4E0D\u5728\u6B64\u8868\uFF0C\u5FC5\u987B\u663E\u5F0F\u4EBA\u5DE5\u786E\u8BA4\u5E76\u8865\u753B\u50CF\u3002",
  profiles: [
    { profileId: "energy-storage.v1", label: "\u50A8\u80FD\u7CFB\u7EDF", industries: ["\u7535\u6C14\u8BBE\u5907-\u7535\u6E90\u8BBE\u5907-\u50A8\u80FD\u8BBE\u5907"], businessModel: "\u50A8\u80FD\u7CFB\u7EDF\u6536\u5165\u53D6\u51B3\u4E8E\u9879\u76EE\u4E2D\u6807\u3001\u4EA4\u4ED8\u4E0E\u7CFB\u7EDF\u96C6\u6210\u80FD\u529B\uFF0C\u5229\u6DA6\u53D7\u7535\u82AF\u4EF7\u683C\u3001\u7CFB\u7EDF\u6548\u7387\u548C\u8D28\u4FDD\u8D23\u4EFB\u5F71\u54CD\u3002", primaryFormula: "\u6536\u5165 = \u50A8\u80FD\u51FA\u8D27 GWh \xD7 \u7CFB\u7EDF\u5355\u4EF7", operatingMetrics: ["\u50A8\u80FD\u51FA\u8D27 GWh", "\u4E2D\u6807\u4E0E\u5728\u624B\u8BA2\u5355", "\u7CFB\u7EDF\u5355\u4EF7", "\u7535\u82AF\u6210\u672C", "\u6D77\u5916\u6536\u5165", "\u8D28\u4FDD\u4E0E\u552E\u540E"], valuationMethods: ["PE", "DCF", "EV/EBIT"], stressFactors: ["\u7535\u82AF\u964D\u4EF7\u5FEB\u4E8E\u552E\u4EF7", "\u6D77\u5916\u8D38\u6613\u58C1\u5792", "\u9879\u76EE\u56DE\u6B3E", "\u5B89\u5168\u4E8B\u6545"] },
    { profileId: "photovoltaic.v1", label: "\u5149\u4F0F\u4EA7\u4E1A\u94FE", industries: ["\u7535\u6C14\u8BBE\u5907-\u7535\u6E90\u8BBE\u5907-\u592A\u9633\u80FD"], businessModel: "\u5149\u4F0F\u5236\u9020\u4E0E\u7CFB\u7EDF\u4E1A\u52A1\u53D7\u7EC4\u4EF6\u51FA\u8D27\u3001\u4EF7\u683C\u3001\u4EA7\u80FD\u5229\u7528\u7387\u548C\u6280\u672F\u8FED\u4EE3\u5171\u540C\u9A71\u52A8\u3002", primaryFormula: "\u5229\u6DA6 = \u51FA\u8D27\u91CF \xD7\uFF08\u5355\u4F4D\u552E\u4EF7 - \u5355\u4F4D\u73B0\u91D1\u6210\u672C\uFF09", operatingMetrics: ["\u7EC4\u4EF6/\u9006\u53D8\u5668\u51FA\u8D27", "\u5355\u4F4D\u552E\u4EF7", "\u4EA7\u80FD\u5229\u7528\u7387", "\u5355\u4F4D\u6210\u672C", "N \u578B\u4EA7\u80FD\u5360\u6BD4", "\u5E93\u5B58\u4E0E\u5E94\u6536"], valuationMethods: ["\u4E2D\u5468\u671F\u5229\u6DA6", "DCF", "EV/EBITDA"], stressFactors: ["\u4F9B\u7ED9\u8FC7\u5269", "\u4EF7\u683C\u6218", "\u6280\u672F\u8DEF\u7EBF\u5207\u6362", "\u6D77\u5916\u5173\u7A0E"] },
    { profileId: "power-grid-equipment.v1", label: "\u7535\u7F51\u4E0E\u7535\u6C14\u8BBE\u5907", industries: ["\u7535\u6C14\u8BBE\u5907-\u7535\u673A-\u7535\u673A", "\u7535\u6C14\u8BBE\u5907-\u5176\u4ED6\u7535\u6C14\u8BBE\u5907-\u5176\u4ED6\u7535\u6C14\u8BBE\u5907", "\u7535\u6C14\u8BBE\u5907-\u8F93\u53D8\u7535\u8BBE\u5907-\u7535\u6C14\u81EA\u63A7\u8BBE\u5907", "\u7535\u6C14\u8BBE\u5907-\u8F93\u53D8\u7535\u8BBE\u5907-\u5176\u4ED6\u8F93\u53D8\u7535\u8BBE\u5907"], businessModel: "\u7535\u7F51\u6295\u8D44\u3001\u5DE5\u4E1A\u8282\u80FD\u548C\u51FA\u53E3\u8BA2\u5355\u9A71\u52A8\u7684\u8BBE\u5907\u5236\u9020\uFF0C\u6838\u5FC3\u5728\u8BA2\u5355\u8D28\u91CF\u3001\u4EA4\u4ED8\u4E0E\u539F\u6750\u6599\u4F20\u5BFC\u3002", primaryFormula: "\u6536\u5165 = \u5728\u624B\u8BA2\u5355 \xD7 \u4EA4\u4ED8\u8FDB\u5EA6 \xD7 \u9A8C\u6536\u7387", operatingMetrics: ["\u56FD\u5BB6\u7535\u7F51\u8BA2\u5355", "\u5728\u624B\u8BA2\u5355", "\u4EA4\u4ED8\u5468\u671F", "\u94DC\u94DD\u4EF7\u683C", "\u6BDB\u5229\u7387", "\u5E94\u6536\u8D26\u6B3E"], valuationMethods: ["PE", "DCF", "EV/EBIT"], stressFactors: ["\u7535\u7F51\u6295\u8D44\u653E\u7F13", "\u539F\u6750\u6599\u6DA8\u4EF7", "\u62DB\u6807\u964D\u4EF7", "\u56DE\u6B3E\u5EF6\u671F"] },
    { profileId: "semiconductor-materials.v1", label: "\u534A\u5BFC\u4F53\u6750\u6599", industries: ["\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599"], businessModel: "\u8BA4\u8BC1\u58C1\u5792\u548C\u5BA2\u6237\u4EA7\u7EBF\u5BFC\u5165\u51B3\u5B9A\u653E\u91CF\u8282\u594F\uFF0C\u6536\u5165\u7531\u5408\u683C\u4EA7\u54C1\u4EFD\u989D\u3001\u6676\u5706\u6295\u7247\u91CF\u548C\u5355\u4F4D\u4EF7\u503C\u91CF\u9A71\u52A8\u3002", primaryFormula: "\u6536\u5165 = \u5BA2\u6237\u6676\u5706\u6295\u7247\u91CF \xD7 \u6E17\u900F\u7387 \xD7 \u5355\u4F4D\u6750\u6599\u4EF7\u503C", operatingMetrics: ["\u5BA2\u6237\u8BA4\u8BC1", "\u56FD\u4EA7\u66FF\u4EE3\u4EFD\u989D", "\u6295\u7247\u91CF", "\u826F\u7387", "\u4EA7\u54C1\u5355\u4EF7", "\u5BA2\u6237\u96C6\u4E2D\u5EA6"], valuationMethods: ["PE", "DCF", "EV/EBIT"], stressFactors: ["\u8BA4\u8BC1\u5EF6\u8FDF", "\u826F\u7387\u4E0D\u8FBE\u6807", "\u6D77\u5916\u9650\u5236", "\u5927\u5BA2\u6237\u964D\u5E93\u5B58"] },
    { profileId: "semiconductor-chip.v1", label: "\u96C6\u6210\u7535\u8DEF\u4E0E\u5206\u7ACB\u5668\u4EF6", industries: ["\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u5206\u7ACB\u5668\u4EF6", "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF"], businessModel: "\u82AF\u7247\u4E1A\u52A1\u7531\u8BBE\u8BA1\u4E2D\u6807\u3001\u51FA\u8D27\u91CF\u3001ASP\u3001\u4EE3\u5DE5\u4F9B\u7ED9\u53CA\u5E93\u5B58\u5468\u671F\u9A71\u52A8\u3002", primaryFormula: "\u6536\u5165 = \u82AF\u7247\u51FA\u8D27\u91CF \xD7 ASP", operatingMetrics: ["\u8BBE\u8BA1\u4E2D\u6807", "\u51FA\u8D27\u91CF", "ASP", "\u5E93\u5B58\u5929\u6570", "\u6BDB\u5229\u7387", "\u4EE3\u5DE5\u4EA7\u80FD", "\u7814\u53D1\u6295\u5165"], valuationMethods: ["PE", "DCF", "EV/EBIT"], stressFactors: ["\u5E93\u5B58\u53BB\u5316", "\u4EF7\u683C\u4E0B\u8DCC", "\u4EA7\u54C1\u8FED\u4EE3\u843D\u540E", "\u51FA\u53E3\u7BA1\u5236"] },
    { profileId: "display-panel.v1", label: "\u663E\u793A\u9762\u677F", industries: ["\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5668\u4EF6-\u663E\u793A\u5668\u4EF6"], businessModel: "\u9762\u677F\u76C8\u5229\u7531\u9762\u79EF\u51FA\u8D27\u3001\u9762\u677F\u4EF7\u683C\u3001\u4EA7\u7EBF\u7A3C\u52A8\u7387\u548C\u6298\u65E7\u5171\u540C\u51B3\u5B9A\uFF0C\u5468\u671F\u6027\u5F3A\u3002", primaryFormula: "\u5229\u6DA6 = \u9762\u79EF\u51FA\u8D27 \xD7\uFF08\u9762\u677F\u5355\u4EF7 - \u5355\u4F4D\u6210\u672C\uFF09- \u6298\u65E7", operatingMetrics: ["\u9762\u677F\u4EF7\u683C", "\u9762\u79EF\u51FA\u8D27", "\u7A3C\u52A8\u7387", "\u4EA7\u54C1\u7ED3\u6784", "\u6298\u65E7", "\u5E93\u5B58"], valuationMethods: ["\u4E2D\u5468\u671F\u5229\u6DA6", "PB", "EV/EBITDA"], stressFactors: ["\u9762\u677F\u4EF7\u683C\u4E0B\u8DCC", "\u7ADE\u4E89\u8005\u6269\u4EA7", "\u4EA7\u7EBF\u6298\u65E7", "\u9700\u6C42\u75B2\u5F31"] },
    { profileId: "electronics-manufacturing.v1", label: "\u7535\u5B50\u5236\u9020\u670D\u52A1", industries: ["\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020"], businessModel: "EMS \u4EE5\u5BA2\u6237\u8BA2\u5355\u3001\u4EA7\u80FD\u5229\u7528\u7387\u548C\u4F9B\u5E94\u94FE\u7BA1\u7406\u8D5A\u53D6\u52A0\u5DE5\u4E0E\u5236\u9020\u6548\u7387\u6536\u76CA\u3002", primaryFormula: "\u6536\u5165 = \u5BA2\u6237\u8BA2\u5355\u91CF \xD7 \u5355\u673A\u4EF7\u503C \xD7 \u4EA4\u4ED8\u7387", operatingMetrics: ["\u5BA2\u6237\u8BA2\u5355", "\u4EA7\u80FD\u5229\u7528\u7387", "\u5236\u9020\u826F\u7387", "\u5BA2\u6237\u96C6\u4E2D\u5EA6", "\u5B58\u8D27\u5468\u8F6C", "\u7ECF\u8425\u73B0\u91D1\u6D41"], valuationMethods: ["PE", "EV/EBIT", "DCF"], stressFactors: ["\u5BA2\u6237\u780D\u5355", "\u4F4E\u6BDB\u5229\u7ADE\u4E89", "\u5B58\u8D27\u8DCC\u4EF7", "\u6D77\u5916\u4EA7\u80FD\u722C\u5761"] },
    { profileId: "electronic-components.v1", label: "\u7535\u5B50\u5143\u4EF6\u4E0E PCB", industries: ["\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5668\u4EF6-\u5176\u4ED6\u7535\u5B50\u5668\u4EF6", "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6"], businessModel: "\u5143\u4EF6\u548C PCB \u9700\u6C42\u53D6\u51B3\u4E8E\u4E0B\u6E38\u7535\u5B50\u51FA\u8D27\u3001\u4EA7\u54C1\u7ED3\u6784\u3001\u7A3C\u52A8\u7387\u4E0E\u94DC\u7B94\u7B49\u6210\u672C\u3002", primaryFormula: "\u6536\u5165 = \u51FA\u8D27\u91CF \xD7 ASP", operatingMetrics: ["\u4E0B\u6E38\u51FA\u8D27", "\u7A3C\u52A8\u7387", "\u9AD8\u7AEF\u4EA7\u54C1\u5360\u6BD4", "ASP", "\u94DC\u7B94\u4E0E\u8986\u94DC\u677F\u6210\u672C", "\u5E93\u5B58\u5468\u8F6C"], valuationMethods: ["PE", "EV/EBIT", "DCF"], stressFactors: ["\u6D88\u8D39\u7535\u5B50\u8D70\u5F31", "\u4EF7\u683C\u7ADE\u4E89", "\u539F\u6599\u6DA8\u4EF7", "\u5BA2\u6237\u96C6\u4E2D"] },
    { profileId: "optical-components.v1", label: "\u5149\u5B66\u5143\u4EF6", industries: ["\u7535\u5B50\u8BBE\u5907-\u5149\u7535\u5B50\u5668\u4EF6-\u5149\u5B66\u5143\u4EF6"], businessModel: "\u7CBE\u5BC6\u5149\u5B66\u96F6\u90E8\u4EF6\u53D7\u7EC8\u7AEF\u5347\u7EA7\u3001\u5BA2\u6237\u5BFC\u5165\u3001\u826F\u7387\u548C\u4EA7\u80FD\u722C\u5761\u9A71\u52A8\u3002", primaryFormula: "\u6536\u5165 = \u7EC8\u7AEF\u51FA\u8D27 \xD7 \u5355\u673A\u5149\u5B66\u4EF7\u503C \xD7 \u4EFD\u989D", operatingMetrics: ["\u5BA2\u6237\u5BFC\u5165", "\u5355\u673A\u4EF7\u503C", "\u826F\u7387", "\u4EA7\u80FD\u5229\u7528\u7387", "\u5927\u5BA2\u6237\u4EFD\u989D", "\u7814\u53D1\u8FDB\u5EA6"], valuationMethods: ["PE", "DCF"], stressFactors: ["\u7EC8\u7AEF\u9700\u6C42\u4E0B\u6ED1", "\u826F\u7387\u6CE2\u52A8", "\u5BA2\u6237\u4EFD\u989D\u4E22\u5931", "\u4EF7\u683C\u4E0B\u538B"] },
    { profileId: "consumer-electronics.v1", label: "\u6D88\u8D39\u7535\u5B50", industries: ["\u7535\u5B50\u8BBE\u5907-\u6D88\u8D39\u7535\u5B50\u8BBE\u5907-\u6D88\u8D39\u7535\u5B50\u8BBE\u5907"], businessModel: "\u6D88\u8D39\u7535\u5B50\u6536\u5165\u7531\u7EC8\u7AEF\u51FA\u8D27\u3001\u5355\u673A\u4EF7\u503C\u3001\u4EA7\u54C1\u5347\u7EA7\u548C\u5BA2\u6237\u4EFD\u989D\u51B3\u5B9A\u3002", primaryFormula: "\u6536\u5165 = \u7EC8\u7AEF\u51FA\u8D27 \xD7 \u5355\u673A\u4EF7\u503C \xD7 \u4F9B\u5E94\u4EFD\u989D", operatingMetrics: ["\u7EC8\u7AEF\u51FA\u8D27", "\u5BA2\u6237\u4EFD\u989D", "\u65B0\u54C1\u5BFC\u5165", "ASP", "\u5E93\u5B58", "\u6BDB\u5229\u7387"], valuationMethods: ["PE", "DCF"], stressFactors: ["\u7EC8\u7AEF\u6362\u673A\u75B2\u5F31", "\u5BA2\u6237\u780D\u5355", "\u65B0\u54C1\u5931\u8D25", "\u4EF7\u683C\u7ADE\u4E89"] },
    { profileId: "property-developer.v1", label: "\u623F\u5730\u4EA7\u5F00\u53D1", industries: ["\u623F\u5730\u4EA7-\u623F\u5730\u4EA7\u5F00\u53D1-\u623F\u5730\u4EA7\u5F00\u53D1"], businessModel: "\u5730\u4EA7\u4EF7\u503C\u53D6\u51B3\u4E8E\u9500\u552E\u53BB\u5316\u3001\u571F\u5730\u50A8\u5907\u8D28\u91CF\u3001\u878D\u8D44\u6210\u672C\u548C\u4EA4\u4ED8\u80FD\u529B\u3002", primaryFormula: "\u7ECF\u8425\u73B0\u91D1\u6D41 = \u9500\u552E\u56DE\u6B3E - \u571F\u5730\u4E0E\u5EFA\u5B89\u6295\u5165 - \u878D\u8D44\u652F\u51FA", operatingMetrics: ["\u5408\u540C\u9500\u552E", "\u53BB\u5316\u7387", "\u571F\u50A8\u8D27\u503C", "\u4EA4\u4ED8", "\u6709\u606F\u8D1F\u503A", "\u7ECF\u8425\u73B0\u91D1\u6D41"], valuationMethods: ["NAV", "PB", "\u5206\u90E8\u4F30\u503C"], stressFactors: ["\u9500\u552E\u4E0B\u6ED1", "\u518D\u878D\u8D44\u53D7\u9650", "\u4EA4\u4ED8\u98CE\u9669", "\u8D44\u4EA7\u51CF\u503C"] },
    { profileId: "apparel.v1", label: "\u670D\u88C5\u4E0E\u5BB6\u7EBA", industries: ["\u7EBA\u7EC7\u670D\u88C5-\u670D\u88C5\u5BB6\u7EBA-\u670D\u88C5"], businessModel: "\u54C1\u724C\u670D\u9970\u589E\u957F\u53D6\u51B3\u4E8E\u540C\u5E97\u3001\u6E20\u9053\u6269\u5F20\u3001\u5E93\u5B58\u548C\u6298\u6263\u7BA1\u7406\u3002", primaryFormula: "\u6536\u5165 = \u95E8\u5E97\u6570 \xD7 \u5355\u5E97\u9500\u552E + \u7535\u5546\u9500\u552E", operatingMetrics: ["\u540C\u5E97\u9500\u552E", "\u95E8\u5E97\u51C0\u5F00", "\u5E93\u5B58\u5468\u8F6C", "\u6298\u6263\u7387", "\u4F1A\u5458\u590D\u8D2D", "\u6BDB\u5229\u7387"], valuationMethods: ["PE", "DCF"], stressFactors: ["\u5E93\u5B58\u79EF\u538B", "\u6298\u6263\u52A0\u6DF1", "\u6E20\u9053\u8D39\u7528\u4E0A\u5347", "\u6D88\u8D39\u8D70\u5F31"] },
    { profileId: "regulated-power.v1", label: "\u6C34\u7535\u4E0E\u65B0\u80FD\u6E90\u8FD0\u8425", industries: ["\u516C\u7528\u4E8B\u4E1A-\u7535\u529B-\u6C34\u7535", "\u516C\u7528\u4E8B\u4E1A-\u7535\u529B-\u65B0\u80FD\u6E90\u53D1\u7535"], businessModel: "\u53D1\u7535\u8FD0\u8425\u4EE5\u53EF\u5229\u7528\u5C0F\u65F6\u3001\u7535\u4EF7\u3001\u88C5\u673A\u6295\u4EA7\u548C\u8D44\u672C\u6210\u672C\u9A71\u52A8\u73B0\u91D1\u6D41\u3002", primaryFormula: "\u6536\u5165 = \u88C5\u673A\u5BB9\u91CF \xD7 \u5229\u7528\u5C0F\u65F6 \xD7 \u4E0A\u7F51\u7535\u4EF7", operatingMetrics: ["\u88C5\u673A\u5BB9\u91CF", "\u5229\u7528\u5C0F\u65F6", "\u4E0A\u7F51\u7535\u4EF7", "\u6765\u6C34/\u98CE\u5149\u8D44\u6E90", "\u5728\u5EFA\u9879\u76EE", "\u8D44\u672C\u5F00\u652F"], valuationMethods: ["DCF", "\u80A1\u5229\u6298\u73B0", "EV/EBITDA"], stressFactors: ["\u6765\u6C34\u504F\u67AF", "\u9650\u7535", "\u7535\u4EF7\u4E0B\u8C03", "\u9AD8\u6760\u6746\u6269\u5F20"] },
    { profileId: "environmental-services.v1", label: "\u73AF\u4FDD\u8FD0\u8425", industries: ["\u516C\u7528\u4E8B\u4E1A-\u73AF\u4FDD-\u73AF\u4FDD"], businessModel: "\u73AF\u4FDD\u9879\u76EE\u4EE5\u7279\u8BB8\u7ECF\u8425\u3001\u5904\u7406\u91CF\u3001\u8865\u8D34\u56DE\u6B3E\u548C\u8D44\u672C\u5F00\u652F\u4E3A\u6838\u5FC3\u3002", primaryFormula: "\u6536\u5165 = \u5904\u7406\u91CF \xD7 \u5355\u4EF7 + \u5DE5\u7A0B\u786E\u8BA4\u6536\u5165", operatingMetrics: ["\u5904\u7406\u91CF", "\u9879\u76EE\u8FD0\u8425\u7387", "\u8865\u8D34\u4E0E\u5E94\u6536", "\u7279\u8BB8\u7ECF\u8425\u671F\u9650", "\u8D44\u672C\u5F00\u652F", "\u7ECF\u8425\u73B0\u91D1\u6D41"], valuationMethods: ["DCF", "EV/EBITDA", "PE"], stressFactors: ["\u5E94\u6536\u56DE\u6B3E", "\u8865\u8D34\u62D6\u6B20", "\u9879\u76EE\u964D\u4EF7", "\u878D\u8D44\u6210\u672C"] },
    { profileId: "defense-equipment.v1", label: "\u519B\u5DE5\u88C5\u5907", industries: ["\u56FD\u9632\u4E0E\u88C5\u5907-\u8239\u8236\u4E0E\u6D77\u6D0B\u88C5\u5907-\u8239\u8236\u5236\u9020", "\u56FD\u9632\u4E0E\u88C5\u5907-\u822A\u7A7A\u822A\u5929\u88C5\u5907-\u822A\u5929\u88C5\u5907"], businessModel: "\u519B\u5DE5\u88C5\u5907\u53D7\u578B\u53F7\u6279\u4EA7\u3001\u8BA2\u5355\u8282\u594F\u3001\u4EA4\u4ED8\u9A8C\u6536\u548C\u4FDD\u5BC6\u5BA2\u6237\u96C6\u4E2D\u5EA6\u9A71\u52A8\u3002", primaryFormula: "\u6536\u5165 = \u578B\u53F7\u8BA2\u5355 \xD7 \u4EA4\u4ED8\u8FDB\u5EA6 \xD7 \u9A8C\u6536\u7387", operatingMetrics: ["\u578B\u53F7\u8BA2\u5355", "\u6279\u4EA7\u8FDB\u5EA6", "\u4EA4\u4ED8\u9A8C\u6536", "\u9884\u4ED8\u6B3E", "\u6BDB\u5229\u7387", "\u5E94\u6536\u4E0E\u5408\u540C\u8D44\u4EA7"], valuationMethods: ["PE", "DCF", "\u5206\u90E8\u4F30\u503C"], stressFactors: ["\u8BA2\u5355\u8282\u594F\u6CE2\u52A8", "\u9A8C\u6536\u5EF6\u8FDF", "\u964D\u4EF7\u5BA1\u4EF7", "\u5E94\u6536\u589E\u52A0"] },
    { profileId: "internet-content.v1", label: "\u4E92\u8054\u7F51\u5185\u5BB9\u4E0E\u6E38\u620F", industries: ["\u4E92\u8054\u7F51-\u4E92\u8054\u7F51\u670D\u52A1-\u7F51\u7EDC\u5A92\u4F53", "\u4E92\u8054\u7F51-\u4E92\u8054\u7F51\u670D\u52A1-\u6E38\u620F\u5A31\u4E50"], businessModel: "\u5185\u5BB9\u5E73\u53F0\u548C\u6E38\u620F\u6536\u5165\u4F9D\u8D56\u7528\u6237\u6D3B\u8DC3\u3001\u5185\u5BB9\u4F9B\u7ED9\u3001\u4ED8\u8D39\u7387\u548C\u83B7\u5BA2\u6548\u7387\u3002", primaryFormula: "\u6536\u5165 = \u6D3B\u8DC3\u7528\u6237 \xD7 \u4ED8\u8D39\u7387 \xD7 ARPPU + \u5E7F\u544A\u53D8\u73B0", operatingMetrics: ["DAU/MAU", "\u4ED8\u8D39\u7387", "ARPPU", "\u5E7F\u544A\u586B\u5145\u7387", "\u5185\u5BB9\u6210\u672C", "\u83B7\u5BA2\u6210\u672C"], valuationMethods: ["PE", "DCF", "EV/\u6536\u5165"], stressFactors: ["\u7528\u6237\u6D41\u5931", "\u7248\u53F7\u4E0E\u76D1\u7BA1", "\u5185\u5BB9\u6210\u672C", "\u4E70\u91CF\u56DE\u62A5\u4E0B\u964D"] },
    { profileId: "internet-finance.v1", label: "\u4E92\u8054\u7F51\u91D1\u878D", industries: ["\u4E92\u8054\u7F51-\u4E92\u8054\u7F51\u91D1\u878D-\u5176\u4ED6\u4E92\u8054\u7F51\u91D1\u878D"], businessModel: "\u4E92\u8054\u7F51\u91D1\u878D\u5E73\u53F0\u7684\u4EF7\u503C\u6765\u81EA\u4EA4\u6613\u6216\u4FE1\u8D37\u89C4\u6A21\u3001\u53D8\u73B0\u7387\u3001\u98CE\u63A7\u8D28\u91CF\u548C\u76D1\u7BA1\u5408\u89C4\u3002", primaryFormula: "\u6536\u5165 = \u4EA4\u6613/\u8D37\u6B3E\u89C4\u6A21 \xD7 \u53D8\u73B0\u7387 - \u4FE1\u7528\u635F\u5931", operatingMetrics: ["\u4EA4\u6613\u989D", "\u8D44\u4EA7\u89C4\u6A21", "\u8D39\u7387", "\u83B7\u5BA2\u6210\u672C", "\u903E\u671F\u7387", "\u76D1\u7BA1\u8D44\u672C"], valuationMethods: ["PE", "DCF", "\u5206\u90E8\u4F30\u503C"], stressFactors: ["\u76D1\u7BA1\u6536\u7D27", "\u4FE1\u7528\u635F\u5931", "\u6D41\u91CF\u6210\u672C", "\u5408\u89C4\u6574\u6539"] },
    { profileId: "coal.v1", label: "\u7164\u70AD\u5F00\u91C7", industries: ["\u5316\u77F3\u80FD\u6E90-\u7164\u70AD-\u7164\u70AD\u5F00\u91C7\u6D17\u9009"], businessModel: "\u7164\u70AD\u76C8\u5229\u7531\u9500\u91CF\u3001\u957F\u534F\u4E0E\u73B0\u8D27\u4EF7\u683C\u3001\u5355\u4F4D\u6210\u672C\u548C\u8D44\u6E90\u63A5\u7EED\u51B3\u5B9A\u3002", primaryFormula: "\u5229\u6DA6 = \u9500\u91CF \xD7\uFF08\u7164\u4EF7 - \u5355\u4F4D\u73B0\u91D1\u6210\u672C\uFF09", operatingMetrics: ["\u7164\u70AD\u4EA7\u9500\u91CF", "\u957F\u534F\u4EF7\u683C", "\u73B0\u8D27\u4EF7\u683C", "\u5355\u4F4D\u6210\u672C", "\u5E93\u5B58", "\u53EF\u91C7\u50A8\u91CF"], valuationMethods: ["\u80A1\u5229\u7387", "\u4E2D\u5468\u671F PE", "DCF"], stressFactors: ["\u7164\u4EF7\u4E0B\u8DCC", "\u5B89\u5168\u4E8B\u6545", "\u4EA7\u91CF\u7EA6\u675F", "\u8D44\u6E90\u67AF\u7AED"] },
    { profileId: "oil-gas.v1", label: "\u6CB9\u6C14\u5F00\u91C7\u4E0E\u670D\u52A1", industries: ["\u5316\u77F3\u80FD\u6E90-\u77F3\u6CB9\u5929\u7136\u6C14-\u77F3\u6CB9\u5929\u7136\u6C14\u5F00\u91C7", "\u5316\u77F3\u80FD\u6E90-\u77F3\u6CB9\u5929\u7136\u6C14-\u6CB9\u7530\u670D\u52A1"], businessModel: "\u6CB9\u6C14\u4E0A\u6E38\u4E0E\u670D\u52A1\u666F\u6C14\u53D7\u6CB9\u4EF7\u3001\u4EA7\u91CF\u3001\u94BB\u5B8C\u4E95\u6295\u8D44\u548C\u5355\u4F4D\u4F5C\u4E1A\u6210\u672C\u9A71\u52A8\u3002", primaryFormula: "\u5229\u6DA6 = \u6CB9\u6C14\u4EA7\u91CF \xD7 \u5B9E\u73B0\u4EF7\u683C - \u73B0\u91D1\u6210\u672C - \u52D8\u63A2\u5F00\u53D1\u6295\u5165", operatingMetrics: ["\u6CB9\u6C14\u4EA7\u91CF", "\u5B9E\u73B0\u6CB9\u4EF7", "\u50A8\u91CF\u66FF\u4EE3\u7387", "\u94BB\u5B8C\u4E95\u5DE5\u4F5C\u91CF", "\u5355\u4F4D\u6210\u672C", "\u8D44\u672C\u5F00\u652F"], valuationMethods: ["NAV", "DCF", "EV/EBITDA"], stressFactors: ["\u6CB9\u4EF7\u4E0B\u8DCC", "\u50A8\u91CF\u4E0B\u4FEE", "\u52D8\u63A2\u5931\u8D25", "\u6D77\u5916\u653F\u6CBB\u98CE\u9669"] },
    { profileId: "oil-refining.v1", label: "\u70BC\u5316", industries: ["\u5316\u77F3\u80FD\u6E90-\u77F3\u6CB9\u5929\u7136\u6C14-\u77F3\u6CB9\u52A0\u5DE5"], businessModel: "\u70BC\u5316\u5229\u6DA6\u53D6\u51B3\u4E8E\u88C2\u89E3\u4EF7\u5DEE\u3001\u88C5\u7F6E\u8D1F\u8377\u3001\u4EA7\u54C1\u7ED3\u6784\u548C\u5E93\u5B58\u635F\u76CA\u3002", primaryFormula: "\u5229\u6DA6 = \u52A0\u5DE5\u91CF \xD7 \u7EFC\u5408\u70BC\u5316\u4EF7\u5DEE - \u80FD\u6E90\u4E0E\u8FD0\u8425\u6210\u672C", operatingMetrics: ["\u70BC\u6CB9\u52A0\u5DE5\u91CF", "\u88C2\u89E3\u4EF7\u5DEE", "PX/\u4E59\u70EF\u4EF7\u5DEE", "\u88C5\u7F6E\u8D1F\u8377", "\u5E93\u5B58\u635F\u76CA", "\u8D44\u672C\u5F00\u652F"], valuationMethods: ["\u4E2D\u5468\u671F\u5229\u6DA6", "EV/EBITDA", "DCF"], stressFactors: ["\u6CB9\u4EF7\u5267\u70C8\u6CE2\u52A8", "\u4EA7\u54C1\u4EF7\u5DEE\u6536\u7A84", "\u65B0\u589E\u4EA7\u80FD", "\u5E93\u5B58\u635F\u5931"] },
    { profileId: "industrial-machinery.v1", label: "\u5DE5\u4E1A\u81EA\u52A8\u5316\u4E0E\u673A\u68B0", industries: ["\u673A\u68B0\u8BBE\u5907-\u673A\u5668\u4EBA-\u5DE5\u4E1A\u673A\u5668\u4EBA", "\u673A\u68B0\u8BBE\u5907-\u91D1\u5C5E\u5236\u54C1-\u91D1\u5C5E\u5236\u54C1", "\u673A\u68B0\u8BBE\u5907-\u901A\u7528\u8BBE\u5907-\u57FA\u7840\u4EF6", "\u673A\u68B0\u8BBE\u5907-\u901A\u7528\u8BBE\u5907-\u5176\u4ED6\u901A\u7528\u673A\u68B0", "\u673A\u68B0\u8BBE\u5907-\u901A\u7528\u8BBE\u5907-\u4EEA\u5668\u4EEA\u8868", "\u673A\u68B0\u8BBE\u5907-\u901A\u7528\u8BBE\u5907-\u5236\u51B7\u7A7A\u8C03\u8BBE\u5907", "\u673A\u68B0\u8BBE\u5907-\u4E13\u7528\u8BBE\u5907-\u5DE5\u7A0B\u673A\u68B0", "\u673A\u68B0\u8BBE\u5907-\u4E13\u7528\u8BBE\u5907-\u5176\u4ED6\u4E13\u7528\u673A\u68B0"], businessModel: "\u5DE5\u4E1A\u8BBE\u5907\u7531\u4E0B\u6E38\u8D44\u672C\u5F00\u652F\u3001\u8BA2\u5355\u3001\u4EA7\u80FD\u5229\u7528\u7387\u548C\u552E\u540E\u670D\u52A1\u9A71\u52A8\u3002", primaryFormula: "\u6536\u5165 = \u65B0\u7B7E\u8BA2\u5355 \xD7 \u4EA4\u4ED8\u7387 + \u5B58\u91CF\u8BBE\u5907\u670D\u52A1\u6536\u5165", operatingMetrics: ["\u65B0\u7B7E\u8BA2\u5355", "\u5728\u624B\u8BA2\u5355", "\u4E0B\u6E38\u8D44\u672C\u5F00\u652F", "\u4EA7\u80FD\u5229\u7528\u7387", "\u670D\u52A1\u6536\u5165", "\u5E94\u6536\u5468\u8F6C"], valuationMethods: ["PE", "DCF", "EV/EBIT"], stressFactors: ["\u8BA2\u5355\u4E0B\u6ED1", "\u4EF7\u683C\u7ADE\u4E89", "\u56DE\u6B3E\u6076\u5316", "\u4E0B\u6E38\u53BB\u5E93\u5B58"] },
    { profileId: "chemical-materials.v1", label: "\u5316\u5DE5\u6750\u6599", industries: ["\u57FA\u7840\u5316\u5DE5-\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102-\u73BB\u7EA4", "\u57FA\u7840\u5316\u5DE5-\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102-\u6DA4\u7EB6", "\u57FA\u7840\u5316\u5DE5-\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102-\u5408\u6210\u6811\u8102", "\u57FA\u7840\u5316\u5DE5-\u5316\u80A5\u519C\u836F-\u6C2E\u80A5", "\u57FA\u7840\u5316\u5DE5-\u5316\u80A5\u519C\u836F-\u94BE\u80A5", "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u65B0\u6750\u6599-\u5316\u5B66\u65B0\u6750\u6599", "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u539F\u6599-\u6C1F\u5316\u5DE5", "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u539F\u6599-\u805A\u6C28\u916F", "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u539F\u6599-\u78F7\u5316\u5DE5", "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u539F\u6599-\u65E0\u673A\u76D0", "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u5236\u54C1-\u5176\u4ED6\u5316\u5B66\u5236\u54C1", "\u57FA\u7840\u5316\u5DE5-\u6A61\u80F6\u5236\u54C1-\u8F6E\u80CE"], businessModel: "\u5316\u5DE5\u6750\u6599\u76C8\u5229\u7531\u4EA7\u54C1\u4EF7\u5DEE\u3001\u4EA7\u80FD\u5229\u7528\u7387\u3001\u539F\u6599\u6210\u672C\u548C\u65B0\u589E\u4F9B\u7ED9\u51B3\u5B9A\u3002", primaryFormula: "\u5229\u6DA6 = \u9500\u91CF \xD7\uFF08\u4EA7\u54C1\u4EF7\u683C - \u539F\u6599\u4E0E\u80FD\u6E90\u6210\u672C\uFF09", operatingMetrics: ["\u4EA7\u54C1\u4EF7\u5DEE", "\u4EA7\u9500\u91CF", "\u4EA7\u80FD\u5229\u7528\u7387", "\u539F\u6599\u4EF7\u683C", "\u5E93\u5B58", "\u65B0\u589E\u4EA7\u80FD"], valuationMethods: ["\u4E2D\u5468\u671F\u5229\u6DA6", "DCF", "EV/EBITDA"], stressFactors: ["\u4F9B\u7ED9\u6269\u5F20", "\u4EF7\u5DEE\u538B\u7F29", "\u539F\u6599\u4E0A\u6DA8", "\u73AF\u4FDD\u4E0E\u5B89\u5168\u4E8B\u6545"] },
    { profileId: "home-appliance.v1", label: "\u5BB6\u7535", industries: ["\u5BB6\u7535-\u767D\u8272\u5BB6\u7535-\u767D\u8272\u5BB6\u7535", "\u5BB6\u7535-\u89C6\u542C\u5668\u6750-\u89C6\u542C\u5668\u6750"], businessModel: "\u5BB6\u7535\u589E\u957F\u7531\u9500\u91CF\u3001\u4EA7\u54C1\u7ED3\u6784\u3001\u6E20\u9053\u6548\u7387\u548C\u539F\u6750\u6599\u6210\u672C\u4F20\u5BFC\u9A71\u52A8\u3002", primaryFormula: "\u6536\u5165\u589E\u957F = \u9500\u91CF\u53D8\u5316 + \u4EF7\u683C/\u7ED3\u6784\u53D8\u5316", operatingMetrics: ["\u96F6\u552E\u9500\u91CF", "\u5747\u4EF7", "\u9AD8\u7AEF\u5360\u6BD4", "\u6E20\u9053\u5E93\u5B58", "\u6D77\u5916\u6536\u5165", "\u539F\u6750\u6599\u6210\u672C"], valuationMethods: ["PE", "DCF", "\u80A1\u5229\u6298\u73B0"], stressFactors: ["\u9700\u6C42\u8D70\u5F31", "\u6E20\u9053\u538B\u8D27", "\u539F\u6599\u6DA8\u4EF7", "\u6D77\u5916\u8D38\u6613\u6469\u64E6"] },
    { profileId: "construction.v1", label: "\u5EFA\u7B51\u5DE5\u7A0B", industries: ["\u5EFA\u7B51-\u5EFA\u7B51\u65BD\u5DE5-\u623F\u5C4B\u5EFA\u7B51"], businessModel: "\u9879\u76EE\u5236\u5EFA\u7B51\u4E1A\u52A1\u4EE5\u65B0\u7B7E\u8BA2\u5355\u3001\u65BD\u5DE5\u8FDB\u5EA6\u3001\u7ED3\u7B97\u548C\u56DE\u6B3E\u51B3\u5B9A\u6536\u5165\u4E0E\u73B0\u91D1\u6D41\u3002", primaryFormula: "\u6536\u5165 = \u5728\u624B\u5408\u540C \xD7 \u5C65\u7EA6\u8FDB\u5EA6", operatingMetrics: ["\u65B0\u7B7E\u5408\u540C", "\u5728\u624B\u8BA2\u5355", "\u5408\u540C\u8D44\u4EA7", "\u5E94\u6536\u8D26\u6B3E", "\u7ECF\u8425\u73B0\u91D1\u6D41", "\u6BDB\u5229\u7387"], valuationMethods: ["PE", "PB", "DCF"], stressFactors: ["\u57FA\u5EFA\u653E\u7F13", "\u56DE\u6B3E\u5EF6\u8FDF", "\u9879\u76EE\u4E8F\u635F", "\u6760\u6746\u4E0A\u5347"] },
    { profileId: "transportation.v1", label: "\u4EA4\u901A\u8FD0\u8F93", industries: ["\u4EA4\u901A\u8FD0\u8F93-\u6E2F\u53E3\u822A\u8FD0-\u822A\u8FD0", "\u4EA4\u901A\u8FD0\u8F93-\u516C\u8DEF\u94C1\u8DEF-\u94C1\u8DEF\u8FD0\u8F93", "\u4EA4\u901A\u8FD0\u8F93-\u822A\u7A7A\u673A\u573A-\u822A\u7A7A", "\u4EA4\u901A\u8FD0\u8F93-\u7269\u6D41-\u7269\u6D41"], businessModel: "\u8FD0\u8F93\u670D\u52A1\u6536\u5165\u7531\u8FD0\u91CF\u3001\u8FD0\u4EF7\u3001\u8F7D\u8FD0\u7387\u548C\u71C3\u6CB9\u7B49\u6210\u672C\u51B3\u5B9A\u3002", primaryFormula: "\u5229\u6DA6 = \u8FD0\u91CF \xD7 \u5355\u4F4D\u8FD0\u4EF7 - \u5355\u4F4D\u8FD0\u8425\u6210\u672C", operatingMetrics: ["\u8FD0\u91CF", "\u8FD0\u4EF7", "\u5BA2\u5EA7/\u88C5\u8F7D\u7387", "\u71C3\u6CB9\u6210\u672C", "\u8FD0\u529B\u6295\u653E", "\u8D44\u672C\u5F00\u652F"], valuationMethods: ["EV/EBITDA", "DCF", "PB"], stressFactors: ["\u8FD0\u4EF7\u4E0B\u8DCC", "\u71C3\u6CB9\u4E0A\u6DA8", "\u8FD0\u529B\u8FC7\u5269", "\u9700\u6C42\u6CE2\u52A8"] },
    { profileId: "automobile.v1", label: "\u6C7D\u8F66\u4E0E\u96F6\u90E8\u4EF6", industries: ["\u4EA4\u8FD0\u8BBE\u5907-\u5176\u4ED6\u4EA4\u8FD0\u8BBE\u5907-\u5176\u4ED6\u4EA4\u8FD0\u8BBE\u5907", "\u4EA4\u8FD0\u8BBE\u5907-\u6C7D\u8F66-\u4E58\u7528\u8F66", "\u4EA4\u8FD0\u8BBE\u5907-\u6C7D\u8F66-\u6C7D\u8F66\u96F6\u90E8\u4EF6", "\u4EA4\u8FD0\u8BBE\u5907-\u6C7D\u8F66-\u5546\u7528\u8F66"], businessModel: "\u6C7D\u8F66\u4EA7\u4E1A\u4EE5\u9500\u91CF\u3001\u5355\u8F66\u4EF7\u503C\u3001\u8F66\u578B\u5468\u671F\u3001\u4EF7\u683C\u7ADE\u4E89\u548C\u4F9B\u5E94\u94FE\u6210\u672C\u9A71\u52A8\u3002", primaryFormula: "\u6536\u5165 = \u9500\u91CF \xD7 \u5355\u8F66\u6536\u5165", operatingMetrics: ["\u9500\u91CF", "\u5355\u8F66 ASP", "\u8F66\u578B\u5468\u671F", "\u65B0\u80FD\u6E90\u6E17\u900F\u7387", "\u5355\u8F66\u6BDB\u5229", "\u6E20\u9053\u5E93\u5B58"], valuationMethods: ["PE", "DCF", "EV/EBIT"], stressFactors: ["\u4EF7\u683C\u6218", "\u8F66\u578B\u5931\u5229", "\u4F9B\u5E94\u94FE\u6DA8\u4EF7", "\u5E93\u5B58\u79EF\u538B"] },
    { profileId: "bank.v1", label: "\u94F6\u884C", industries: ["\u91D1\u878D-\u94F6\u884C-\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C", "\u91D1\u878D-\u94F6\u884C-\u56FD\u6709\u94F6\u884C"], businessModel: "\u94F6\u884C\u4EE5\u51C0\u606F\u5DEE\u3001\u4FE1\u7528\u6210\u672C\u3001\u8D44\u672C\u7EA6\u675F\u548C\u4E2D\u6536\u9A71\u52A8\u80A1\u4E1C\u56DE\u62A5\u3002", primaryFormula: "\u957F\u671F\u4EF7\u503C = \u53EF\u6301\u7EED ROE - \u80A1\u6743\u8D44\u672C\u6210\u672C", operatingMetrics: ["\u51C0\u606F\u5DEE", "\u8D37\u6B3E\u589E\u901F", "\u4E0D\u826F\u7387", "\u62E8\u5907\u8986\u76D6\u7387", "\u4FE1\u7528\u6210\u672C", "\u6838\u5FC3\u4E00\u7EA7\u8D44\u672C"], valuationMethods: ["PB", "\u80A1\u5229\u6298\u73B0", "\u5269\u4F59\u6536\u76CA"], stressFactors: ["\u606F\u5DEE\u6536\u7A84", "\u4E0D\u826F\u4E0A\u5347", "\u8D44\u672C\u4E0D\u8DB3", "\u518D\u878D\u8D44\u644A\u8584"] },
    { profileId: "insurance.v1", label: "\u4FDD\u9669", industries: ["\u91D1\u878D-\u975E\u94F6\u884C\u91D1\u878D-\u4FDD\u9669"], businessModel: "\u4FDD\u9669\u4EF7\u503C\u7531\u627F\u4FDD/\u65B0\u4E1A\u52A1\u4EF7\u503C\u3001\u51C6\u5907\u91D1\u3001\u6295\u8D44\u6536\u76CA\u548C\u507F\u4ED8\u80FD\u529B\u5171\u540C\u51B3\u5B9A\u3002", primaryFormula: "\u4EF7\u503C = \u627F\u4FDD\u73B0\u91D1\u6D41\u6216\u5185\u542B\u4EF7\u503C + \u6295\u8D44\u7EC4\u5408\u4EF7\u503C", operatingMetrics: ["\u4FDD\u8D39", "\u7EFC\u5408\u6210\u672C\u7387/\u65B0\u4E1A\u52A1\u4EF7\u503C", "\u51C6\u5907\u91D1", "\u6295\u8D44\u6536\u76CA", "\u507F\u4ED8\u80FD\u529B", "\u9000\u4FDD\u7387"], valuationMethods: ["PB", "\u5185\u542B\u4EF7\u503C", "\u5269\u4F59\u6536\u76CA"], stressFactors: ["\u8D54\u4ED8\u6076\u5316", "\u5229\u5DEE\u635F", "\u8D44\u4EA7\u51CF\u503C", "\u507F\u4ED8\u80FD\u529B\u4E0B\u964D"] },
    { profileId: "brokerage.v1", label: "\u8BC1\u5238", industries: ["\u91D1\u878D-\u975E\u94F6\u884C\u91D1\u878D-\u8BC1\u5238"], businessModel: "\u5238\u5546\u4E1A\u7EE9\u53D6\u51B3\u4E8E\u5E02\u573A\u6210\u4EA4\u3001\u4E24\u878D\u3001\u6295\u884C\u9879\u76EE\u3001\u8D44\u7BA1\u89C4\u6A21\u4E0E\u81EA\u8425\u98CE\u9669\u3002", primaryFormula: "\u5229\u6DA6 = \u7ECF\u7EAA\u4E0E\u4E24\u878D\u6536\u5165 + \u6295\u884C\u8D44\u7BA1\u6536\u5165 + \u6295\u8D44\u6536\u76CA - \u4FE1\u7528\u51CF\u503C", operatingMetrics: ["\u5E02\u573A\u6210\u4EA4\u989D", "\u4E24\u878D\u4F59\u989D", "\u6295\u884C\u4E1A\u52A1\u50A8\u5907", "\u8D44\u7BA1\u89C4\u6A21", "\u81EA\u8425\u655E\u53E3", "\u51C0\u8D44\u672C"], valuationMethods: ["PB", "PE", "\u5206\u90E8\u4F30\u503C"], stressFactors: ["\u5E02\u573A\u4F4E\u8FF7", "\u81EA\u8425\u56DE\u64A4", "\u4FE1\u7528\u51CF\u503C", "\u76D1\u7BA1\u5904\u7F5A"] },
    { profileId: "livestock.v1", label: "\u517B\u6B96\u4E0E\u9972\u6599", industries: ["\u519C\u6797\u7267\u6E14-\u755C\u7267\u4E1A-\u9972\u6599", "\u519C\u6797\u7267\u6E14-\u755C\u7267\u4E1A-\u517B\u6B96"], businessModel: "\u517B\u6B96\u5229\u6DA6\u7531\u51FA\u680F\u91CF\u3001\u755C\u79BD\u4EF7\u683C\u3001\u9972\u6599\u6210\u672C\u548C\u75AB\u75C5\u63A7\u5236\u51B3\u5B9A\u3002", primaryFormula: "\u5229\u6DA6 = \u51FA\u680F\u91CF \xD7\uFF08\u9500\u552E\u4EF7\u683C - \u5355\u4F4D\u517B\u6B96\u6210\u672C\uFF09", operatingMetrics: ["\u51FA\u680F\u91CF", "\u5546\u54C1\u4EF7\u683C", "\u6599\u8089\u6BD4", "\u9972\u6599\u6210\u672C", "\u5B58\u680F", "\u75AB\u75C5\u635F\u5931"], valuationMethods: ["\u4E2D\u5468\u671F\u5229\u6DA6", "PB", "DCF"], stressFactors: ["\u4EF7\u683C\u4E0B\u8DCC", "\u75AB\u75C5", "\u9972\u6599\u6DA8\u4EF7", "\u4EA7\u80FD\u8FC7\u5269"] },
    { profileId: "paper-packaging.v1", label: "\u9020\u7EB8\u4E0E\u5305\u88C5", industries: ["\u8F7B\u5DE5\u5236\u9020-\u9020\u7EB8\u5370\u5237-\u5305\u88C5\u5370\u5237", "\u8F7B\u5DE5\u5236\u9020-\u9020\u7EB8\u5370\u5237-\u9020\u7EB8"], businessModel: "\u7EB8\u54C1\u4E0E\u5305\u88C5\u76C8\u5229\u53D6\u51B3\u4E8E\u9500\u91CF\u3001\u7EB8\u4EF7\u3001\u6D46\u4EF7\u548C\u5BA2\u6237\u7ED3\u6784\u3002", primaryFormula: "\u5229\u6DA6 = \u9500\u91CF \xD7\uFF08\u7EB8\u4EF7/\u52A0\u5DE5\u8D39 - \u6D46\u7EB8\u4E0E\u80FD\u6E90\u6210\u672C\uFF09", operatingMetrics: ["\u9500\u91CF", "\u7EB8\u4EF7", "\u6D46\u4EF7", "\u4EA7\u80FD\u5229\u7528\u7387", "\u5E93\u5B58", "\u5BA2\u6237\u96C6\u4E2D\u5EA6"], valuationMethods: ["\u4E2D\u5468\u671F PE", "DCF", "EV/EBITDA"], stressFactors: ["\u7EB8\u4EF7\u4E0B\u8DCC", "\u6D46\u4EF7\u4E0A\u6DA8", "\u4F9B\u7ED9\u6269\u5F20", "\u9700\u6C42\u8D70\u5F31"] },
    { profileId: "retail.v1", label: "\u8FDE\u9501\u96F6\u552E", industries: ["\u5546\u8D38\u96F6\u552E-\u96F6\u552E-\u8FDE\u9501"], businessModel: "\u8FDE\u9501\u96F6\u552E\u7531\u540C\u5E97\u3001\u95E8\u5E97\u51C0\u589E\u3001\u4F9B\u5E94\u94FE\u6548\u7387\u548C\u5E93\u5B58\u5468\u8F6C\u9A71\u52A8\u3002", primaryFormula: "\u6536\u5165 = \u95E8\u5E97\u6570 \xD7 \u5355\u5E97\u9500\u552E", operatingMetrics: ["\u540C\u5E97\u9500\u552E", "\u95E8\u5E97\u51C0\u5F00", "\u5BA2\u6D41", "\u5BA2\u5355\u4EF7", "\u5E93\u5B58\u5468\u8F6C", "\u79DF\u8D41\u8D1F\u503A"], valuationMethods: ["PE", "DCF", "EV/EBIT"], stressFactors: ["\u540C\u5E97\u4E0B\u6ED1", "\u5E93\u5B58\u79EF\u538B", "\u79DF\u91D1\u4E0A\u6DA8", "\u7EBF\u4E0A\u5206\u6D41"] },
    { profileId: "food.v1", label: "\u98DF\u54C1\u4E0E\u8C03\u5473\u54C1", industries: ["\u98DF\u54C1\u996E\u6599-\u98DF\u54C1-\u8C03\u5473\u54C1", "\u98DF\u54C1\u996E\u6599-\u98DF\u54C1-\u8089\u5236\u54C1", "\u98DF\u54C1\u996E\u6599-\u98DF\u54C1-\u4E73\u5236\u54C1", "\u98DF\u54C1\u996E\u6599-\u98DF\u54C1-\u98DF\u54C1\u7EFC\u5408"], businessModel: "\u98DF\u54C1\u516C\u53F8\u7531\u9500\u91CF\u3001\u63D0\u4EF7\u3001\u4EA7\u54C1\u7ED3\u6784\u3001\u6E20\u9053\u5E93\u5B58\u548C\u539F\u6599\u6210\u672C\u9A71\u52A8\u3002", primaryFormula: "\u6536\u5165\u589E\u957F = \u9500\u91CF + \u4EF7\u683C + \u4EA7\u54C1\u7ED3\u6784", operatingMetrics: ["\u7EC8\u7AEF\u52A8\u9500", "\u63D0\u4EF7", "\u6E20\u9053\u5E93\u5B58", "\u65B0\u54C1", "\u539F\u6599\u6210\u672C", "\u8D39\u7528\u7387"], valuationMethods: ["PE", "DCF"], stressFactors: ["\u9700\u6C42\u75B2\u5F31", "\u6E20\u9053\u538B\u8D27", "\u539F\u6599\u6DA8\u4EF7", "\u4EF7\u683C\u6218"] },
    { profileId: "beverages.v1", label: "\u767D\u9152\u4E0E\u996E\u6599", industries: ["\u98DF\u54C1\u996E\u6599-\u996E\u6599-\u767D\u9152", "\u98DF\u54C1\u996E\u6599-\u996E\u6599-\u8F6F\u996E\u6599"], businessModel: "\u996E\u6599\u54C1\u724C\u7684\u589E\u957F\u53D6\u51B3\u4E8E\u7EC8\u7AEF\u52A8\u9500\u3001\u4EF7\u683C\u5E26\u3001\u6E20\u9053\u638C\u63A7\u548C\u54C1\u724C\u52BF\u80FD\u3002", primaryFormula: "\u6536\u5165 = \u9500\u91CF \xD7 \u5355\u4EF7 + \u4EA7\u54C1\u7ED3\u6784\u5347\u7EA7", operatingMetrics: ["\u7EC8\u7AEF\u52A8\u9500", "\u6279\u4EF7", "\u6E20\u9053\u5E93\u5B58", "\u4EF7\u683C\u5E26", "\u7ECF\u9500\u5546", "\u5E02\u573A\u4EFD\u989D"], valuationMethods: ["PE", "DCF", "EV/EBIT"], stressFactors: ["\u6279\u4EF7\u4E0B\u884C", "\u6E20\u9053\u538B\u8D27", "\u6D88\u8D39\u964D\u7EA7", "\u7ADE\u4E89\u52A0\u5267"] },
    { profileId: "software.v1", label: "\u8F6F\u4EF6", industries: ["\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u8F6F\u4EF6-\u57FA\u7840\u8F6F\u4EF6", "\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u8F6F\u4EF6-\u884C\u4E1A\u5E94\u7528\u8F6F\u4EF6"], businessModel: "\u8F6F\u4EF6\u4E1A\u52A1\u7531\u5BA2\u6237\u6570\u3001\u7EED\u8D39\u3001\u9879\u76EE\u4EA4\u4ED8\u548C\u7814\u53D1\u4EA7\u54C1\u5316\u80FD\u529B\u9A71\u52A8\u3002", primaryFormula: "\u6536\u5165 = \u65B0\u589E\u5408\u540C + \u5B58\u91CF\u7EED\u8D39\u4E0E\u6269\u5BB9", operatingMetrics: ["\u5408\u540C\u989D", "\u7EED\u8D39\u7387", "RPO", "\u9879\u76EE\u4EA4\u4ED8", "\u4EBA\u5747\u4EA7\u51FA", "\u7ECF\u8425\u73B0\u91D1\u6D41"], valuationMethods: ["PE", "EV/\u6536\u5165", "DCF"], stressFactors: ["\u9879\u76EE\u5EF6\u671F", "\u56DE\u6B3E\u6076\u5316", "\u7814\u53D1\u6295\u5165\u5931\u6548", "\u4EF7\u683C\u7ADE\u4E89"] },
    { profileId: "it-services.v1", label: "IT \u670D\u52A1", industries: ["\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u8F6F\u4EF6-\u5176\u4ED6\u8F6F\u4EF6\u670D\u52A1"], businessModel: "IT \u670D\u52A1\u6536\u5165\u4E3B\u8981\u7531\u9879\u76EE\u8BA2\u5355\u3001\u4EBA\u5458\u4EA4\u4ED8\u6548\u7387\u548C\u56DE\u6B3E\u8D28\u91CF\u51B3\u5B9A\u3002", primaryFormula: "\u6536\u5165 = \u53EF\u4EA4\u4ED8\u4EBA\u529B \xD7 \u4EBA\u5747\u6536\u5165 + \u9879\u76EE\u4EA4\u4ED8", operatingMetrics: ["\u5728\u624B\u8BA2\u5355", "\u4EBA\u5747\u4EA7\u51FA", "\u4EBA\u5458\u5229\u7528\u7387", "\u9879\u76EE\u6BDB\u5229", "\u5E94\u6536\u8D26\u6B3E", "\u73B0\u91D1\u56DE\u6B3E"], valuationMethods: ["PE", "DCF"], stressFactors: ["\u4EBA\u529B\u6210\u672C", "\u9879\u76EE\u5EF6\u671F", "\u56DE\u6B3E\u98CE\u9669", "\u5BA2\u6237\u9884\u7B97\u6536\u7F29"] },
    { profileId: "computer-hardware.v1", label: "\u8BA1\u7B97\u673A\u786C\u4EF6", industries: ["\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u786C\u4EF6-\u4E13\u7528\u8BA1\u7B97\u673A\u8BBE\u5907", "\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u786C\u4EF6-PC\u3001\u670D\u52A1\u5668\u53CA\u786C\u4EF6"], businessModel: "\u8BA1\u7B97\u673A\u786C\u4EF6\u7531\u4E0B\u6E38\u8D44\u672C\u5F00\u652F\u3001\u51FA\u8D27\u91CF\u3001\u4EA7\u54C1\u7ED3\u6784\u548C\u4F9B\u5E94\u94FE\u6210\u672C\u51B3\u5B9A\u3002", primaryFormula: "\u6536\u5165 = \u51FA\u8D27\u91CF \xD7 \u5355\u673A ASP", operatingMetrics: ["\u670D\u52A1\u5668/\u8BBE\u5907\u51FA\u8D27", "ASP", "AI \u4EA7\u54C1\u5360\u6BD4", "\u5BA2\u6237\u8D44\u672C\u5F00\u652F", "\u5E93\u5B58", "\u6BDB\u5229\u7387"], valuationMethods: ["PE", "DCF", "EV/EBIT"], stressFactors: ["\u8D44\u672C\u5F00\u652F\u4E0B\u884C", "\u5B58\u8D27\u8DCC\u4EF7", "\u4F9B\u5E94\u94FE\u7EA6\u675F", "\u4EF7\u683C\u7ADE\u4E89"] },
    { profileId: "telecom-equipment.v1", label: "\u901A\u4FE1\u8BBE\u5907", industries: ["\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8BBE\u5907-\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907", "\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8BBE\u5907-\u901A\u4FE1\u7EC8\u7AEF\u8BBE\u5907"], businessModel: "\u901A\u4FE1\u8BBE\u5907\u7531\u8FD0\u8425\u5546\u4E0E\u4E91\u5382\u5546\u8D44\u672C\u5F00\u652F\u3001\u4EA7\u54C1\u4EE3\u9645\u3001\u5BA2\u6237\u8BA4\u8BC1\u548C\u4EA4\u4ED8\u9A71\u52A8\u3002", primaryFormula: "\u6536\u5165 = \u5BA2\u6237\u8D44\u672C\u5F00\u652F \xD7 \u8BBE\u5907\u4EFD\u989D \xD7 \u4EA4\u4ED8\u7387", operatingMetrics: ["\u8FD0\u8425\u5546/\u4E91\u5382\u5546\u8D44\u672C\u5F00\u652F", "\u8BA2\u5355", "\u9AD8\u7AEF\u4EA7\u54C1\u5360\u6BD4", "\u5BA2\u6237\u8BA4\u8BC1", "\u6BDB\u5229\u7387", "\u5E94\u6536"], valuationMethods: ["PE", "DCF", "EV/EBIT"], stressFactors: ["\u8D44\u672C\u5F00\u652F\u4E0B\u8C03", "\u6280\u672F\u8FED\u4EE3", "\u5BA2\u6237\u96C6\u4E2D", "\u6D77\u5916\u9650\u5236"] },
    { profileId: "telecom-operator.v1", label: "\u901A\u4FE1\u8FD0\u8425\u5546", industries: ["\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8FD0\u8425-\u901A\u4FE1\u8FD0\u8425"], businessModel: "\u8FD0\u8425\u5546\u4EE5\u7528\u6237\u3001ARPU\u3001\u4E91\u7F51\u4E1A\u52A1\u548C\u8D44\u672C\u5F00\u652F\u6548\u7387\u51B3\u5B9A\u81EA\u7531\u73B0\u91D1\u6D41\u3002", primaryFormula: "\u6536\u5165 = \u7528\u6237\u6570 \xD7 ARPU + \u653F\u4F01\u4E91\u7F51\u6536\u5165", operatingMetrics: ["\u79FB\u52A8\u7528\u6237", "ARPU", "\u5BBD\u5E26\u7528\u6237", "\u653F\u4F01\u6536\u5165", "\u8D44\u672C\u5F00\u652F", "\u81EA\u7531\u73B0\u91D1\u6D41"], valuationMethods: ["\u80A1\u5229\u6298\u73B0", "DCF", "EV/EBITDA"], stressFactors: ["ARPU \u4E0B\u884C", "\u8D44\u672C\u5F00\u652F\u4E0A\u5347", "\u7ADE\u4E89\u52A0\u5267", "\u4E91\u4E1A\u52A1\u6295\u5165"] },
    { profileId: "pharma.v1", label: "\u5236\u836F", industries: ["\u533B\u836F\u751F\u7269-\u4FDD\u5065\u62A4\u7406-\u4FDD\u5065\u62A4\u7406\u4EA7\u54C1", "\u533B\u836F\u751F\u7269-\u5316\u5B66\u5236\u836F-\u5316\u5B66\u539F\u6599\u836F", "\u533B\u836F\u751F\u7269-\u5316\u5B66\u5236\u836F-\u5316\u5B66\u5236\u5242"], businessModel: "\u5236\u836F\u6536\u5165\u7531\u6838\u5FC3\u54C1\u79CD\u9500\u91CF\u3001\u4EF7\u683C\u3001\u533B\u4FDD\u652F\u4ED8\u3001\u7BA1\u7EBF\u4E0E\u539F\u6599\u6210\u672C\u51B3\u5B9A\u3002", primaryFormula: "\u6536\u5165 = \u60A3\u8005\u6570 \xD7 \u6E17\u900F\u7387 \xD7 \u7597\u7A0B\u4EF7\u683C", operatingMetrics: ["\u6838\u5FC3\u54C1\u79CD", "\u533B\u4FDD\u4E0E\u96C6\u91C7", "\u7814\u53D1\u7BA1\u7EBF", "\u539F\u6599\u6210\u672C", "\u9500\u552E\u8D39\u7528", "\u5E94\u6536"], valuationMethods: ["PE", "DCF", "\u5206\u90E8\u4F30\u503C"], stressFactors: ["\u96C6\u91C7\u964D\u4EF7", "\u6838\u5FC3\u54C1\u79CD\u4E0B\u6ED1", "\u7814\u53D1\u5931\u8D25", "\u5408\u89C4\u98CE\u9669"] },
    { profileId: "biotech.v1", label: "\u751F\u7269\u533B\u836F", industries: ["\u533B\u836F\u751F\u7269-\u751F\u7269\u533B\u836F-\u751F\u7269\u533B\u836F"], businessModel: "\u751F\u7269\u533B\u836F\u4EF7\u503C\u4F9D\u8D56\u4E34\u5E8A\u91CC\u7A0B\u7891\u3001\u83B7\u6279\u6982\u7387\u3001\u5546\u4E1A\u5316\u722C\u5761\u548C\u73B0\u91D1\u8DD1\u9053\u3002", primaryFormula: "\u98CE\u9669\u8C03\u6574\u4EF7\u503C = \u5404\u7BA1\u7EBF\u5CF0\u503C\u9500\u552E \xD7 \u6210\u529F\u6982\u7387\u7684\u73B0\u503C", operatingMetrics: ["\u4E34\u5E8A\u8FDB\u5EA6", "\u9002\u5E94\u75C7", "\u6210\u529F\u6982\u7387", "\u73B0\u91D1\u8DD1\u9053", "\u5546\u4E1A\u5316\u6536\u5165", "\u80A1\u6743\u7A00\u91CA"], valuationMethods: ["rNPV", "DCF", "\u5206\u90E8\u4F30\u503C"], stressFactors: ["\u4E34\u5E8A\u5931\u8D25", "\u878D\u8D44\u7A00\u91CA", "\u7ADE\u4E89\u836F\u7269", "\u533B\u4FDD\u8C08\u5224"] },
    { profileId: "healthcare-services.v1", label: "\u533B\u7597\u670D\u52A1\u4E0E\u5668\u68B0", industries: ["\u533B\u836F\u751F\u7269-\u533B\u7597\u670D\u52A1-\u533B\u7597\u670D\u52A1", "\u533B\u836F\u751F\u7269-\u533B\u7597\u5668\u68B0-\u533B\u7597\u5668\u68B0"], businessModel: "\u533B\u7597\u670D\u52A1\u548C\u5668\u68B0\u7531\u60A3\u8005\u91CF\u3001\u6E17\u900F\u7387\u3001\u5355\u4EF7\u3001\u9662\u7AEF\u51C6\u5165\u548C\u8017\u6750\u653F\u7B56\u9A71\u52A8\u3002", primaryFormula: "\u6536\u5165 = \u60A3\u8005/\u88C5\u673A\u91CF \xD7 \u5355\u6B21\u6536\u8D39\u6216\u8017\u6750\u4EF7\u503C", operatingMetrics: ["\u60A3\u8005\u91CF/\u88C5\u673A\u91CF", "\u9662\u7AEF\u51C6\u5165", "\u8017\u6750\u6536\u5165", "\u5355\u4EF7", "\u533B\u4FDD\u653F\u7B56", "\u5E94\u6536"], valuationMethods: ["PE", "DCF", "EV/\u6536\u5165"], stressFactors: ["\u96C6\u91C7", "\u9662\u7AEF\u9884\u7B97", "\u51C6\u5165\u5EF6\u8FDF", "\u5408\u89C4\u98CE\u9669"] },
    { profileId: "gold.v1", label: "\u9EC4\u91D1", industries: ["\u6709\u8272\u91D1\u5C5E-\u8D35\u91D1\u5C5E-\u9EC4\u91D1"], businessModel: "\u9EC4\u91D1\u77FF\u4F01\u76C8\u5229\u7531\u91D1\u4EA7\u91CF\u3001\u5B9E\u73B0\u4EF7\u683C\u3001\u5168\u7EF4\u6301\u6210\u672C\u548C\u50A8\u91CF\u63A5\u7EED\u51B3\u5B9A\u3002", primaryFormula: "\u5229\u6DA6 = \u9EC4\u91D1\u4EA7\u91CF \xD7\uFF08\u91D1\u4EF7 - AISC\uFF09", operatingMetrics: ["\u9EC4\u91D1\u4EA7\u91CF", "AISC", "\u91D1\u4EF7", "\u50A8\u91CF\u5BFF\u547D", "\u54C1\u4F4D", "\u8D44\u672C\u5F00\u652F"], valuationMethods: ["NAV", "DCF", "EV/EBITDA"], stressFactors: ["\u91D1\u4EF7\u56DE\u843D", "\u54C1\u4F4D\u4E0B\u964D", "\u77FF\u5C71\u4E8B\u6545", "\u6D77\u5916\u8D44\u4EA7\u98CE\u9669"] },
    { profileId: "base-metals.v1", label: "\u57FA\u672C\u91D1\u5C5E", industries: ["\u6709\u8272\u91D1\u5C5E-\u57FA\u672C\u91D1\u5C5E-\u94DD", "\u6709\u8272\u91D1\u5C5E-\u57FA\u672C\u91D1\u5C5E-\u94DC"], businessModel: "\u94DC\u94DD\u4F01\u4E1A\u4EE5\u4EA7\u9500\u91CF\u3001\u91D1\u5C5E\u4EF7\u683C\u3001\u80FD\u6E90\u6210\u672C\u548C\u51B6\u70BC\u52A0\u5DE5\u8D39\u9A71\u52A8\u5468\u671F\u5229\u6DA6\u3002", primaryFormula: "\u5229\u6DA6 = \u91D1\u5C5E\u4EA7\u91CF \xD7\uFF08\u5B9E\u73B0\u4EF7\u683C - \u73B0\u91D1\u6210\u672C\uFF09", operatingMetrics: ["\u4EA7\u9500\u91CF", "\u94DC\u94DD\u4EF7\u683C", "\u52A0\u5DE5\u8D39", "\u80FD\u6E90\u6210\u672C", "\u5E93\u5B58", "\u8D44\u672C\u5F00\u652F"], valuationMethods: ["\u4E2D\u5468\u671F\u5229\u6DA6", "NAV", "DCF"], stressFactors: ["\u91D1\u5C5E\u4EF7\u683C\u4E0B\u8DCC", "\u80FD\u6E90\u6210\u672C\u4E0A\u6DA8", "\u4F9B\u7ED9\u6269\u5F20", "\u8D44\u6E90\u54C1\u4F4D\u4E0B\u964D"] },
    { profileId: "battery-and-rare-metals.v1", label: "\u7535\u6C60\u6750\u6599\u4E0E\u7A00\u6709\u91D1\u5C5E", industries: ["\u6709\u8272\u91D1\u5C5E-\u91D1\u5C5E\u975E\u91D1\u5C5E\u65B0\u6750\u6599-\u7535\u6C60\u6750\u6599", "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u9502", "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u5176\u4ED6\u7A00\u6709\u5C0F\u91D1\u5C5E", "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u94A8", "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u7A00\u571F"], businessModel: "\u7535\u6C60\u6750\u6599\u548C\u7A00\u6709\u91D1\u5C5E\u53D7\u4E0B\u6E38\u9700\u6C42\u3001\u4EF7\u683C\u3001\u4F9B\u7ED9\u6295\u653E\u3001\u6210\u672C\u66F2\u7EBF\u548C\u5E93\u5B58\u5468\u671F\u9A71\u52A8\u3002", primaryFormula: "\u5229\u6DA6 = \u9500\u91CF \xD7\uFF08\u4EA7\u54C1\u4EF7\u683C - \u5355\u4F4D\u73B0\u91D1\u6210\u672C\uFF09", operatingMetrics: ["\u4E0B\u6E38\u9700\u6C42", "\u4EA7\u54C1\u4EF7\u683C", "\u4EA7\u9500\u91CF", "\u6210\u672C\u66F2\u7EBF", "\u5E93\u5B58", "\u65B0\u589E\u4F9B\u7ED9"], valuationMethods: ["\u4E2D\u5468\u671F\u5229\u6DA6", "NAV", "DCF"], stressFactors: ["\u4EF7\u683C\u4E0B\u8DCC", "\u4F9B\u7ED9\u6269\u5F20", "\u6280\u672F\u66FF\u4EE3", "\u51FA\u53E3\u9650\u5236"] }
  ]
};

// config/eastmoney-company-em2016-profiles.json
var eastmoney_company_em2016_profiles_default = {
  schemaVersion: "eastmoney-company-em2016-profiles.v1",
  taxonomy: "eastmoney-em2016.v1",
  generatedAt: "2026-08-11T09:26:00.402Z",
  source: {
    endpoint: "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_ORG_BASICINFO",
    field: "EM2016",
    inputPath: "web/src/config/institutional-track-snapshot.json"
  },
  coverage: {
    total: 302,
    available: 302,
    unavailable: 0
  },
  profiles: [
    {
      code: "000001.SZ",
      name: "\u5E73\u5B89\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C"
      ],
      mainBusiness: "(\u4E00)\u5438\u6536\u516C\u4F17\u5B58\u6B3E;(\u4E8C)\u53D1\u653E\u77ED\u671F\u3001\u4E2D\u671F\u548C\u957F\u671F\u8D37\u6B3E;(\u4E09)\u529E\u7406\u56FD\u5185\u5916\u7ED3\u7B97;(\u56DB)\u529E\u7406\u7968\u636E\u627F\u5151\u4E0E\u8D34\u73B0;(\u4E94)\u53D1\u884C\u91D1\u878D\u503A\u5238;(\u516D)\u4EE3\u7406\u53D1\u884C\u3001\u4EE3\u7406\u5151\u4ED8\u3001\u627F\u9500\u653F\u5E9C\u503A\u5238;(\u4E03)\u4E70\u5356\u653F\u5E9C\u503A\u5238\u3001\u91D1\u878D\u503A\u5238;(\u516B)\u4ECE\u4E8B\u540C\u4E1A\u62C6\u501F;(\u4E5D)\u4E70\u5356\u3001\u4EE3\u7406\u4E70\u5356\u5916\u6C47;(\u5341)\u4ECE\u4E8B\u94F6\u884C\u5361\u4E1A\u52A1;(\u5341\u4E00)\u63D0\u4F9B\u4FE1\u7528\u8BC1\u670D\u52A1\u53CA\u62C5\u4FDD;(\u5341\u4E8C)\u4EE3\u7406\u6536\u4ED8\u6B3E\u9879\u53CA\u4EE3\u7406\u4FDD\u9669\u4E1A\u52A1;(\u5341\u4E09)\u63D0\u4F9B\u4FDD\u7BA1\u7BB1\u670D\u52A1;(\u5341\u56DB)\u7ED3\u6C47\u3001\u552E\u6C47\u4E1A\u52A1;(\u5341\u4E94)\u79BB\u5CB8\u94F6\u884C\u4E1A\u52A1;(\u5341\u516D)\u8D44\u4EA7\u6258\u7BA1\u4E1A\u52A1;(\u5341\u4E03)\u529E\u7406\u9EC4\u91D1\u4E1A\u52A1;(\u5341\u516B)\u8D22\u52A1\u987E\u95EE\u3001\u8D44\u4FE1\u8C03\u67E5\u3001\u54A8\u8BE2\u3001\u89C1\u8BC1\u4E1A\u52A1;(\u5341\u4E5D)\u7ECF\u6709\u5173\u76D1\u7BA1\u673A\u6784\u6279\u51C6\u7684\u5176\u4ED6\u4E1A\u52A1",
      products: [
        "\u96F6\u552E\u91D1\u878D\u4E1A\u52A1",
        "\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C"
      ]
    },
    {
      code: "000100.SZ",
      name: "TCL\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u534A\u5BFC\u4F53\u663E\u793A\u4E1A\u52A1,\u65B0\u80FD\u6E90\u5149\u4F0F\u53CA\u5176\u4ED6\u7845\u6750\u6599\u4E1A\u52A1",
      products: [
        "\u534A\u5BFC\u4F53\u663E\u793A\u4E1A\u52A1",
        "\u6DB2\u6676\u663E\u793A\u9762\u677F\u3001\u7535\u5B50\u5206\u9500\u670D\u52A1\u3001\u5176\u4ED6\u534A\u5BFC\u4F53\u6750\u6599"
      ]
    },
    {
      code: "000333.SZ",
      name: "\u7F8E\u7684\u96C6\u56E2",
      availability: "available",
      industry: "\u5BB6\u7535-\u767D\u8272\u5BB6\u7535-\u767D\u8272\u5BB6\u7535",
      industryLevels: [
        "\u5BB6\u7535",
        "\u767D\u8272\u5BB6\u7535",
        "\u767D\u8272\u5BB6\u7535"
      ],
      mainBusiness: "\u667A\u80FD\u5BB6\u5C45\u3001\u5DE5\u4E1A\u6280\u672F\u3001\u697C\u5B87\u79D1\u6280\u3001\u673A\u5668\u4EBA\u4E0E\u81EA\u52A8\u5316\u3001\u65B0\u80FD\u6E90\u3001\u5065\u5EB7\u533B\u7597\u3001\u667A\u6167\u7269\u6D41\u7B49\u4E1A\u52A1",
      products: [
        "\u667A\u80FD\u5BB6\u5C45\u4E1A\u52A1",
        "\u667A\u80FD\u5BB6\u5C45\u4EA7\u54C1\u3001\u81EA\u52A8\u5316\u8BBE\u5907"
      ]
    },
    {
      code: "000338.SZ",
      name: "\u6F4D\u67F4\u52A8\u529B",
      availability: "available",
      industry: "\u4EA4\u8FD0\u8BBE\u5907-\u6C7D\u8F66-\u6C7D\u8F66\u96F6\u90E8\u4EF6",
      industryLevels: [
        "\u4EA4\u8FD0\u8BBE\u5907",
        "\u6C7D\u8F66",
        "\u6C7D\u8F66\u96F6\u90E8\u4EF6"
      ],
      mainBusiness: "\u52A8\u529B\u7CFB\u7EDF\u4E1A\u52A1\u3001\u5546\u7528\u8F66\u4E1A\u52A1\u3001\u519C\u4E1A\u88C5\u5907\u4E1A\u52A1\u3001\u667A\u6167\u7269\u6D41\u4E1A\u52A1\u3001\u7535\u529B\u80FD\u6E90\u4E1A\u52A1",
      products: [
        "\u667A\u80FD\u7269\u6D41",
        "\u91CD\u578B\u5361\u8F66\u3001\u53C9\u8F66\u3001\u519C\u7528\u673A\u68B0\u3001\u5176\u4ED6\u6C7D\u8F66\u96F6\u4EF6\u4E0E\u8BBE\u5907"
      ]
    },
    {
      code: "000408.SZ",
      name: "\u85CF\u683C\u77FF\u4E1A",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u80A5\u519C\u836F-\u94BE\u80A5",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u80A5\u519C\u836F",
        "\u94BE\u80A5"
      ],
      mainBusiness: "\u6C2F\u5316\u94BE\u3001\u78B3\u9178\u9502\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u6C2F\u5316\u94BE",
        "\u6C2F\u5316\u94BE\u3001\u7535\u6C60\u7EA7\u78B3\u9178\u9502"
      ]
    },
    {
      code: "000425.SZ",
      name: "\u5F90\u5DE5\u673A\u68B0",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u4E13\u7528\u8BBE\u5907-\u5DE5\u7A0B\u673A\u68B0",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u4E13\u7528\u8BBE\u5907",
        "\u5DE5\u7A0B\u673A\u68B0"
      ],
      mainBusiness: "\u571F\u65B9\u673A\u68B0\u3001\u8D77\u91CD\u673A\u68B0\u3001\u6869\u5DE5\u673A\u68B0\u3001\u6DF7\u51DD\u571F\u673A\u68B0\u3001\u8DEF\u9762\u673A\u68B0\u3001\u9AD8\u7A7A\u4F5C\u4E1A\u673A\u68B0\u3001\u77FF\u4E1A\u673A\u68B0\u3001\u73AF\u536B\u673A\u68B0\u3001\u519C\u4E1A\u673A\u68B0\u3001\u5E94\u6025\u6551\u63F4\u88C5\u5907\u548C\u5176\u4ED6\u5DE5\u7A0B\u673A\u68B0\u53CA\u5907\u4EF6\u7684\u7814\u53D1\u3001\u5236\u9020\u3001\u9500\u552E\u548C\u670D\u52A1\u5DE5\u4F5C\u3002",
      products: [
        "\u571F\u65B9\u673A\u68B0",
        "\u571F\u65B9\u673A\u68B0\u3001\u5DE5\u7A0B\u673A\u68B0\u3001\u8D77\u91CD\u673A\u68B0\u3001\u77FF\u91C7\u673A\u68B0\u3001\u9AD8\u7A7A\u4F5C\u4E1A\u673A\u68B0\u3001\u6869\u5DE5\u673A\u68B0\u3001\u7B51\u517B\u8DEF\u673A\u68B0"
      ]
    },
    {
      code: "000568.SZ",
      name: "\u6CF8\u5DDE\u8001\u7A96",
      availability: "available",
      industry: "\u98DF\u54C1\u996E\u6599-\u996E\u6599-\u767D\u9152",
      industryLevels: [
        "\u98DF\u54C1\u996E\u6599",
        "\u996E\u6599",
        "\u767D\u9152"
      ],
      mainBusiness: "\u6CF8\u5DDE\u8001\u7A96\u7CFB\u5217\u9152\u7684\u751F\u4EA7\u3001\u9500\u552E\u3002",
      products: [
        "\u4E2D\u9AD8\u6863\u9152",
        "\u767D\u9152\u3001\u767D\u9152"
      ]
    },
    {
      code: "000636.SZ",
      name: "\u98CE\u534E\u9AD8\u79D1",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u7814\u5236\u3001\u751F\u4EA7\u3001\u9500\u552E\u7535\u5B50\u5143\u5668\u4EF6\u3001\u7535\u5B50\u6750\u6599\u7B49\u3002",
      products: [
        "\u7535\u5B50\u5143\u5668\u4EF6",
        "\u88AB\u52A8\u5143\u4EF6"
      ]
    },
    {
      code: "000651.SZ",
      name: "\u683C\u529B\u7535\u5668",
      availability: "available",
      industry: "\u5BB6\u7535-\u767D\u8272\u5BB6\u7535-\u767D\u8272\u5BB6\u7535",
      industryLevels: [
        "\u5BB6\u7535",
        "\u767D\u8272\u5BB6\u7535",
        "\u767D\u8272\u5BB6\u7535"
      ],
      mainBusiness: "\u4ECE\u4E8B\u6D88\u8D39\u7535\u5668\u53CA\u5176\u914D\u4EF6\u7684\u751F\u4EA7\u53CA\u9500\u552E",
      products: [
        "\u6D88\u8D39\u7535\u5668",
        "\u7A7A\u8C03\u3001\u6C7D\u8F66\u7A7A\u8C03\u3001\u667A\u80FD\u5236\u9020\u88C5\u5907"
      ]
    },
    {
      code: "000657.SZ",
      name: "\u4E2D\u94A8\u9AD8\u65B0",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u94A8",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u7A00\u6709\u91D1\u5C5E",
        "\u94A8"
      ],
      mainBusiness: "\u94A8\u7CBE\u77FF\u3001\u4EF2\u94A8\u9178\u94F5\u3001\u94A8\u7C89\u53CA\u78B3\u5316\u94A8\u7C89\u3001\u786C\u8D28\u5408\u91D1\u548C\u94A8\u3001\u94BC\u3001\u94BD\u3001\u94CC\u7B49\u6709\u8272\u91D1\u5C5E\u53CA\u5176\u6DF1\u52A0\u5DE5\u4EA7\u54C1\u548C\u88C5\u5907\u7684\u7814\u5236\u3001\u5F00\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E\u53CA\u8D38\u6613\u4E1A\u52A1\u7B49",
      products: [
        "\u7CBE\u77FF\u53CA\u7C89\u672B\u4EA7\u54C1",
        "\u94A8\u7C89\u3001\u786C\u8D28\u5408\u91D1\u3001\u91D1\u5C5E\u5207\u524A\u673A\u5E8A\u7528\u5207\u524A\u5200\u5177\u3001\u94A8\u3001\u8D38\u6613\u516C\u53F8\u4E0E\u8D44\u672C\u54C1\u7ECF\u9500\u5546"
      ]
    },
    {
      code: "000725.SZ",
      name: "\u4EAC\u4E1C\u65B9A",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5668\u4EF6-\u663E\u793A\u5668\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5668\u4EF6",
        "\u663E\u793A\u5668\u4EF6"
      ],
      mainBusiness: "\u663E\u793A\u5668\u4EF6,\u7269\u8054\u7F51\u521B\u65B0,\u4F20\u611F,MLED,\u667A\u6167\u533B\u5DE5,\u201CN\u201D\u4E1A\u52A1",
      products: [
        "\u663E\u793A\u5668\u4EF6\u4E1A\u52A1",
        "\u663E\u793A\u5668\u4EF6\u3001\u667A\u80FD\u663E\u793A\u7EC8\u7AEF\u3001LED\u663E\u793A\u5668\u4EF6\u3001\u5728\u7EBF\u533B\u7597\u670D\u52A1\u5E73\u53F0\u3001\u4F20\u611F\u5668"
      ]
    },
    {
      code: "000776.SZ",
      name: "\u5E7F\u53D1\u8BC1\u5238",
      availability: "available",
      industry: "\u91D1\u878D-\u975E\u94F6\u884C\u91D1\u878D-\u8BC1\u5238",
      industryLevels: [
        "\u91D1\u878D",
        "\u975E\u94F6\u884C\u91D1\u878D",
        "\u8BC1\u5238"
      ],
      mainBusiness: "\u6295\u8D44\u94F6\u884C\u4E1A\u52A1,\u8D22\u5BCC\u7BA1\u7406\u4E1A\u52A1,\u4EA4\u6613\u53CA\u673A\u6784\u4E1A\u52A1,\u6295\u8D44\u7BA1\u7406\u4E1A\u52A1",
      products: [
        "\u4EA4\u6613\u53CA\u673A\u6784\u4E1A\u52A1",
        "\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238"
      ]
    },
    {
      code: "000792.SZ",
      name: "\u76D0\u6E56\u80A1\u4EFD",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u80A5\u519C\u836F-\u94BE\u80A5",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u80A5\u519C\u836F",
        "\u94BE\u80A5"
      ],
      mainBusiness: "\u6C2F\u5316\u94BE\u53CA\u78B3\u9178\u9502\u7684\u751F\u4EA7\u3001\u9500\u552E",
      products: [
        "\u6C2F\u5316\u94BE\u548C\u78B3\u9178\u9502\u4EA7\u54C1",
        "\u6C2F\u5316\u94BE\u3001\u78B3\u9178\u9502\u3001\u5316\u5DE5\u4EA7\u54C1\u8D38\u6613"
      ]
    },
    {
      code: "000811.SZ",
      name: "\u51B0\u8F6E\u73AF\u5883",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u901A\u7528\u8BBE\u5907-\u5236\u51B7\u7A7A\u8C03\u8BBE\u5907",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u901A\u7528\u8BBE\u5907",
        "\u5236\u51B7\u7A7A\u8C03\u8BBE\u5907"
      ],
      mainBusiness: "\u4F4E\u6E29\u51B7\u51BB\u8BBE\u5907\u3001\u4E2D\u592E\u7A7A\u8C03\u8BBE\u5907\u3001\u8282\u80FD\u5236\u70ED\u8BBE\u5907\u3001\u80FD\u6E90\u5316\u5DE5\u538B\u7F29/\u6DB2\u5316\u88C5\u5907\u3001\u7CBE\u5BC6\u94F8\u4EF6\u3001\u667A\u80FD\u4ED3\u50A8\u88C5\u5907\u3001\u6C22\u80FD\u88C5\u5907\u7B49\u4EA7\u4E1A\u96C6\u7FA4",
      products: [
        "\u5DE5\u4E1A\u4EA7\u54C1\u9500\u552E",
        "\u5DE5\u5546\u7528\u5236\u51B7\u8BBE\u5907\u3001\u4E13\u4E1A\u5DE5\u7A0B"
      ]
    },
    {
      code: "000858.SZ",
      name: "\u4E94\u7CAE\u6DB2",
      availability: "available",
      industry: "\u98DF\u54C1\u996E\u6599-\u996E\u6599-\u767D\u9152",
      industryLevels: [
        "\u98DF\u54C1\u996E\u6599",
        "\u996E\u6599",
        "\u767D\u9152"
      ],
      mainBusiness: "\u767D\u9152\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u9152\u7C7B",
        "\u767D\u9152"
      ]
    },
    {
      code: "000895.SZ",
      name: "\u53CC\u6C47\u53D1\u5C55",
      availability: "available",
      industry: "\u98DF\u54C1\u996E\u6599-\u98DF\u54C1-\u8089\u5236\u54C1",
      industryLevels: [
        "\u98DF\u54C1\u996E\u6599",
        "\u98DF\u54C1",
        "\u8089\u5236\u54C1"
      ],
      mainBusiness: "\u4ECE\u4E8B\u5C60\u5BB0\u4E1A\u53CA\u8089\u5236\u54C1\u52A0\u5DE5\u4E1A",
      products: [
        "\u732A\u8089\u3001\u6DF1\u52A0\u5DE5\u8089\u5236\u54C1"
      ]
    },
    {
      code: "000933.SZ",
      name: "\u795E\u706B\u80A1\u4EFD",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u57FA\u672C\u91D1\u5C5E-\u94DD",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u57FA\u672C\u91D1\u5C5E",
        "\u94DD"
      ],
      mainBusiness: "\u94DD\u4EA7\u54C1\u3001\u7164\u70AD\u7684\u751F\u4EA7\u3001\u52A0\u5DE5\u548C\u9500\u552E\u3002",
      products: [
        "\u94DD\u952D",
        "\u94DD\u952D\u3001\u7164\u70AD\u3001\u94DD\u7B94\u3001\u94DD\u7B94\u3001\u5546\u54C1\u8D38\u6613"
      ]
    },
    {
      code: "000938.SZ",
      name: "\u7D2B\u5149\u80A1\u4EFD",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u8F6F\u4EF6-\u5176\u4ED6\u8F6F\u4EF6\u670D\u52A1",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u8BA1\u7B97\u673A\u8F6F\u4EF6",
        "\u5176\u4ED6\u8F6F\u4EF6\u670D\u52A1"
      ],
      mainBusiness: "\u4FE1\u606F\u7535\u5B50\u53CA\u76F8\u5173\u4EA7\u4E1A\u3002",
      products: [
        "ICT\u57FA\u7840\u8BBE\u65BD\u4E0E\u670D\u52A1",
        "\u6570\u636E\u4E2D\u5FC3\u7CFB\u7EDF\u96C6\u6210\u3001\u7535\u8111\u4E0E\u5916\u56F4\u8BBE\u5907\u96F6\u552E"
      ]
    },
    {
      code: "000962.SZ",
      name: "\u4E1C\u65B9\u94BD\u4E1A",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u5176\u4ED6\u7A00\u6709\u5C0F\u91D1\u5C5E",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u7A00\u6709\u91D1\u5C5E",
        "\u5176\u4ED6\u7A00\u6709\u5C0F\u91D1\u5C5E"
      ],
      mainBusiness: "\u94BD\u94CC\u91D1\u5C5E\u53CA\u5176\u5408\u91D1\u5236\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u53CA\u9500\u552E",
      products: [
        "\u94BD\u94CC\u53CA\u5176\u5408\u91D1\u5236\u54C1",
        "\u7A00\u6709\u96BE\u7194\u91D1\u5C5E\u3001\u949B"
      ]
    },
    {
      code: "000975.SZ",
      name: "\u5C71\u91D1\u56FD\u9645",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u8D35\u91D1\u5C5E-\u9EC4\u91D1",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u8D35\u91D1\u5C5E",
        "\u9EC4\u91D1"
      ],
      mainBusiness: "\u8D35\u91D1\u5C5E\u548C\u6709\u8272\u91D1\u5C5E\u77FF\u91C7\u9009\u53CA\u91D1\u5C5E\u8D38\u6613",
      products: [
        "\u77FF\u4EA7\u91D1",
        "\u9EC4\u91D1\u3001\u6709\u8272\u91D1\u5C5E\u8D38\u6613\u3001\u6709\u8272\u91D1\u5C5E\u8D38\u6613\u3001\u5408\u8D28\u91D1\u3001\u6709\u8272\u91D1\u5C5E\u8D38\u6613\u3001\u6709\u8272\u91D1\u5C5E\u8D38\u6613\u3001\u5176\u4ED6\u91D1\u5C5E\u4E0E\u91C7\u77FF\u3001\u950C\u77FF\u3001\u94C5\u77FF\u3001\u6709\u8272\u91D1\u5C5E\u8D38\u6613\u3001\u5408\u8D28\u91D1\u3001\u6709\u8272\u91D1\u5C5E\u8D38\u6613"
      ]
    },
    {
      code: "000977.SZ",
      name: "\u6D6A\u6F6E\u4FE1\u606F",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u786C\u4EF6-PC\u3001\u670D\u52A1\u5668\u53CA\u786C\u4EF6",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u8BA1\u7B97\u673A\u786C\u4EF6",
        "PC\u3001\u670D\u52A1\u5668\u53CA\u786C\u4EF6"
      ],
      mainBusiness: "\u5168\u7403\u9886\u5148\u7684IT\u57FA\u7840\u8BBE\u65BD\u4EA7\u54C1\u3001\u65B9\u6848\u548C\u670D\u52A1\u63D0\u4F9B\u5546,\u4E3A\u5BA2\u6237\u63D0\u4F9B\u4E91\u8BA1\u7B97\u3001\u5927\u6570\u636E\u3001\u4EBA\u5DE5\u667A\u80FD\u7B49\u5404\u7C7B\u521B\u65B0IT\u4EA7\u54C1\u548C\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u670D\u52A1\u5668",
        "\u670D\u52A1\u5668\u3001\u7535\u8111\u786C\u4EF6"
      ]
    },
    {
      code: "001248.SZ",
      name: "\u534E\u6DA6\u65B0\u80FD\u6E90",
      availability: "available",
      industry: "\u516C\u7528\u4E8B\u4E1A-\u7535\u529B-\u65B0\u80FD\u6E90\u53D1\u7535",
      industryLevels: [
        "\u516C\u7528\u4E8B\u4E1A",
        "\u7535\u529B",
        "\u65B0\u80FD\u6E90\u53D1\u7535"
      ],
      mainBusiness: "\u6295\u8D44\u3001\u5F00\u53D1\u3001\u8FD0\u8425\u548C\u7BA1\u7406\u98CE\u529B\u3001\u592A\u9633\u80FD\u53D1\u7535\u7AD9",
      products: [
        "\u98CE\u529B\u53D1\u7535",
        "\u98CE\u529B\u53D1\u7535\u3001\u5149\u4F0F\u53D1\u7535"
      ]
    },
    {
      code: "001257.SZ",
      name: "\u76DB\u9F99\u80A1\u4EFD",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u5176\u4ED6\u7A00\u6709\u5C0F\u91D1\u5C5E",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u7A00\u6709\u91D1\u5C5E",
        "\u5176\u4ED6\u7A00\u6709\u5C0F\u91D1\u5C5E"
      ],
      mainBusiness: "\u94BC\u76F8\u5173\u4EA7\u54C1\u7684\u751F\u4EA7\u3001\u52A0\u5DE5\u3001\u9500\u552E\u4E1A\u52A1",
      products: [
        "\u94BC\u7CBE\u77FF",
        "\u94BC\u52A0\u5DE5\u4EA7\u54C1\u3001\u94BC\u77FF\u3001\u94BC\u52A0\u5DE5\u4EA7\u54C1\u3001\u94BC\u52A0\u5DE5\u4EA7\u54C1\u3001\u94DC\u77FF"
      ]
    },
    {
      code: "001309.SZ",
      name: "\u5FB7\u660E\u5229",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u662F\u4E00\u5BB6\u4E13\u4E1A\u5B58\u50A8\u63A7\u5236\u82AF\u7247\u53CA\u89E3\u51B3\u65B9\u6848\u63D0\u4F9B\u5546,\u6838\u5FC3\u80FD\u529B\u6E90\u4E8E\u81EA\u4E3B\u53EF\u63A7\u7684\u5B58\u50A8\u4E3B\u63A7\u82AF\u7247\u4E0E\u56FA\u4EF6\u65B9\u6848\u7814\u53D1,\u53CA\u5176\u4EA7\u4E1A\u5316\u5E94\u7528\u7684\u957F\u671F\u6DF1\u8015\u3002\u516C\u53F8\u7ECF\u8FC7\u591A\u5E74\u79EF\u7D2F,\u6784\u5EFA\u4E86\u201C\u786C\u79D1\u6280+\u8F6F\u670D\u52A1\u201D\u7684\u53CC\u8F6E\u652F\u6491\u4F53\u7CFB,\u638C\u63E1\u4E86\u81EA\u4E3B\u53EF\u63A7\u7684\u4E3B\u63A7\u82AF\u7247\u7814\u53D1\u6838\u5FC3\u6280\u672F,\u540C\u6B65\u5F62\u6210\u56FA\u4EF6\u89E3\u51B3\u65B9\u6848\u53CA\u91CF\u4EA7\u4F18\u5316\u5DE5\u5177\u6838\u5FC3\u6280\u672F,\u592F\u5B9E\u89E3\u51B3\u65B9\u6848\u7684\u6280\u672F\u6839\u57FA\u3002\u5728\u6B64\u57FA\u7840\u4E0A,\u516C\u53F8\u6301\u7EED\u6DF1\u5316\u201C\u4ECE\u5E95\u5C42\u6280\u672F\u5230\u7EC8\u7AEF\u573A\u666F\u201D\u7684\u5168\u94FE\u8DEF\u5E03\u5C40,\u63A8\u52A8\u4E1A\u52A1\u6A21\u5F0F\u4ECE\u5355\u7EAF\u4EA7\u54C1\u9500\u552E\u9010\u6B65\u5411\u573A\u666F\u5316\u3001\u5B9A\u5236\u5316\u89E3\u51B3\u65B9\u6848\u8F6C\u578B\u5347\u7EA7,\u4F7F\u5B58\u50A8\u6A21\u7EC4\u6210\u4E3A\u89E3\u51B3\u65B9\u6848\u843D\u5730\u7684\u91CD\u8981\u8F7D\u4F53,\u4E3A\u5BA2\u6237\u63D0\u4F9B\u4E00\u7AD9\u5F0F\u3001\u5168\u94FE\u8DEF\u5B58\u50A8\u89E3\u51B3\u65B9\u6848\u670D\u52A1\u3002",
      products: [
        "\u5B58\u50A8\u4EA7\u54C1",
        "\u96C6\u6210\u7535\u8DEF\u8BBE\u8BA1\u3001\u96C6\u6210\u7535\u8DEF\u8BBE\u8BA1\u3001\u96C6\u6210\u7535\u8DEF\u8BBE\u8BA1\u3001\u5B58\u50A8\u8BBE\u5907"
      ]
    },
    {
      code: "001389.SZ",
      name: "\u5E7F\u5408\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u591A\u9AD8\u5C42\u5370\u5236\u7535\u8DEF\u677F\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "PCB\u677F",
        "\u5370\u5236\u7535\u8DEF\u677F"
      ]
    },
    {
      code: "001399.SZ",
      name: "\u60E0\u79D1\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u6750\u6599"
      ],
      mainBusiness: "\u534A\u5BFC\u4F53\u663E\u793A\u9762\u677F\u7B49\u6838\u5FC3\u663E\u793A\u5668\u4EF6\u4EE5\u53CA\u667A\u80FD\u663E\u793A\u7EC8\u7AEF\u7684\u7814\u53D1\u3001\u5236\u9020\u548C\u9500\u552E",
      products: [
        "\u534A\u5BFC\u4F53\u663E\u793A\u9762\u677F",
        "\u6DB2\u6676\u663E\u793A\u9762\u677F"
      ]
    },
    {
      code: "001979.SZ",
      name: "\u62DB\u5546\u86C7\u53E3",
      availability: "available",
      industry: "\u623F\u5730\u4EA7-\u623F\u5730\u4EA7\u5F00\u53D1-\u623F\u5730\u4EA7\u5F00\u53D1",
      industryLevels: [
        "\u623F\u5730\u4EA7",
        "\u623F\u5730\u4EA7\u5F00\u53D1",
        "\u623F\u5730\u4EA7\u5F00\u53D1"
      ],
      mainBusiness: "\u5F00\u53D1\u4E1A\u52A1\u4E3B\u8425\u4EE5\u4F4F\u5B85\u4E3A\u4E3B\u7684\u53EF\u552E\u578B\u5546\u54C1\u623F\u7684\u5F00\u53D1\u4E0E\u9500\u552E,\u6B64\u5916\u8FD8\u5305\u62EC\u4EE3\u5EFA\u4E1A\u52A1;\u8D44\u4EA7\u8FD0\u8425\u4E1A\u52A1\u5305\u62EC\u96C6\u4E2D\u5546\u4E1A\u3001\u4EA7\u4E1A\u529E\u516C\u3001\u516C\u5BD3\u9152\u5E97\u7B49\u6301\u6709\u7269\u4E1A\u8FD0\u8425\u4E0E\u8D44\u4EA7\u7BA1\u7406\u4EE5\u53CA\u4F1A\u5C55\u548C\u90AE\u8F6E\u4E1A\u52A1;\u7269\u4E1A\u670D\u52A1\u4E1A\u52A1\u5305\u62EC\u57FA\u7840\u7269\u4E1A\u7BA1\u7406\u3001\u5E73\u53F0\u589E\u503C\u670D\u52A1\u53CA\u4E13\u4E1A\u589E\u503C\u670D\u52A1\u7B49",
      products: [
        "\u5F00\u53D1\u4E1A\u52A1",
        "\u5546\u54C1\u623F\u5F00\u53D1\u3001\u7269\u4E1A\u7BA1\u7406\u3001\u56ED\u533A\u5730\u4EA7\u7ECF\u8425"
      ]
    },
    {
      code: "002001.SZ",
      name: "\u65B0\u548C\u6210",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u4FDD\u5065\u62A4\u7406-\u4FDD\u5065\u62A4\u7406\u4EA7\u54C1",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u4FDD\u5065\u62A4\u7406",
        "\u4FDD\u5065\u62A4\u7406\u4EA7\u54C1"
      ],
      mainBusiness: "\u516C\u53F8\u662F\u4E00\u5BB6\u4E3B\u8981\u4ECE\u4E8B\u8425\u517B\u54C1\u3001\u9999\u7CBE\u9999\u6599\u3001\u9AD8\u5206\u5B50\u6750\u6599\u3001\u539F\u6599\u836F\u751F\u4EA7\u548C\u9500\u552E\u7684\u56FD\u5BB6\u7EA7\u9AD8\u65B0\u6280\u672F\u4F01\u4E1A",
      products: [
        "\u8425\u517B\u54C1",
        "\u7EF4\u751F\u7D20\u3001\u9999\u7CBE\u9999\u6599\u3001\u5DE5\u7A0B\u5851\u6599"
      ]
    },
    {
      code: "002008.SZ",
      name: "\u5927\u65CF\u6FC0\u5149",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u667A\u80FD\u5236\u9020\u88C5\u5907\u53CA\u5176\u5173\u952E\u5668\u4EF6\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u5176\u4ED6\u667A\u80FD\u5236\u9020\u88C5\u5907",
        "\u667A\u80FD\u5236\u9020\u88C5\u5907\u3001PCB\u751F\u4EA7\u8BBE\u5907"
      ]
    },
    {
      code: "002027.SZ",
      name: "\u5206\u4F17\u4F20\u5A92",
      availability: "available",
      industry: "\u4E92\u8054\u7F51-\u4E92\u8054\u7F51\u670D\u52A1-\u7F51\u7EDC\u5A92\u4F53",
      industryLevels: [
        "\u4E92\u8054\u7F51",
        "\u4E92\u8054\u7F51\u670D\u52A1",
        "\u7F51\u7EDC\u5A92\u4F53"
      ],
      mainBusiness: "\u751F\u6D3B\u5708\u5A92\u4F53\u7684\u5F00\u53D1\u548C\u8FD0\u8425,\u4E3B\u8981\u4EA7\u54C1\u4E3A\u697C\u5B87\u5A92\u4F53(\u5305\u542B\u7535\u68AF\u7535\u89C6\u5A92\u4F53\u548C\u7535\u68AF\u6D77\u62A5\u5A92\u4F53)\u3001\u5F71\u9662\u94F6\u5E55\u5E7F\u544A\u5A92\u4F53\u548C\u7EC8\u7AEF\u5356\u573A\u5A92\u4F53\u7B49,\u8986\u76D6\u57CE\u5E02\u4E3B\u6D41\u6D88\u8D39\u4EBA\u7FA4\u7684\u5DE5\u4F5C\u573A\u666F\u3001\u751F\u6D3B\u573A\u666F\u3001\u5A31\u4E50\u573A\u666F\u548C\u6D88\u8D39\u573A\u666F,\u5E76\u76F8\u4E92\u6574\u5408\u6210\u4E3A\u751F\u6D3B\u5708\u5A92\u4F53\u7F51\u7EDC\u3002",
      products: [
        "\u697C\u5B87\u5A92\u4F53",
        "\u697C\u5B87\u5E7F\u544A\u6295\u653E\u3001\u5F71\u9662\u5E7F\u544A\u6295\u653E\u3001\u5E7F\u544A\u670D\u52A1"
      ]
    },
    {
      code: "002028.SZ",
      name: "\u601D\u6E90\u7535\u6C14",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u8F93\u53D8\u7535\u8BBE\u5907-\u7535\u6C14\u81EA\u63A7\u8BBE\u5907",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u8F93\u53D8\u7535\u8BBE\u5907",
        "\u7535\u6C14\u81EA\u63A7\u8BBE\u5907"
      ],
      mainBusiness: "\u8F93\u914D\u7535\u8BBE\u5907\u53CA\u5176\u6838\u5FC3\u96F6\u90E8\u4EF6\u7684\u7814\u53D1\u3001\u8BBE\u8BA1\u3001\u5236\u9020\u3001\u9500\u552E\u53CA\u670D\u52A1\u4E0E\u5DE5\u7A0B\u603B\u5305",
      products: [
        "\u5F00\u5173\u7C7B\u4E1A\u52A1",
        "\u9AD8\u538B\u5F00\u5173\u67DC\u3001\u53D8\u538B\u5668\u3001\u8F93\u914D\u7535\u8BBE\u5907\u3001\u7535\u529B\u5DE5\u7A0B\u3001\u50A8\u80FD\u7CFB\u7EDF\u3001\u7535\u5B50\u8BBE\u5907\u3001\u79DF\u8D41\u670D\u52A1"
      ]
    },
    {
      code: "002050.SZ",
      name: "\u4E09\u82B1\u667A\u63A7",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u901A\u7528\u8BBE\u5907-\u5176\u4ED6\u901A\u7528\u673A\u68B0",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u901A\u7528\u8BBE\u5907",
        "\u5176\u4ED6\u901A\u7528\u673A\u68B0"
      ],
      mainBusiness: "\u5236\u51B7\u7A7A\u8C03\u7535\u5668\u4E0E\u6C7D\u8F66\u7684\u96F6\u4EF6\u90E8\u4EF6\u7EC4\u4EF6\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u7A7A\u8C03\u51B0\u7BB1\u4E4B\u5143\u5668\u4EF6\u53CA\u90E8\u4EF6",
        "\u7A7A\u8C03\u914D\u4EF6\u3001\u6C7D\u8F66\u7A7A\u8C03\u96F6\u90E8\u4EF6"
      ]
    },
    {
      code: "002078.SZ",
      name: "\u592A\u9633\u7EB8\u4E1A",
      availability: "available",
      industry: "\u8F7B\u5DE5\u5236\u9020-\u9020\u7EB8\u5370\u5237-\u9020\u7EB8",
      industryLevels: [
        "\u8F7B\u5DE5\u5236\u9020",
        "\u9020\u7EB8\u5370\u5237",
        "\u9020\u7EB8"
      ],
      mainBusiness: "\u673A\u5236\u7EB8\u3001\u7EB8\u5236\u54C1\u3001\u6728\u6D46\u3001\u7EB8\u677F\u7684\u751F\u4EA7\u548C\u9500\u552E,\u7535\u529B\u3001\u70ED\u529B\u7684\u751F\u4EA7\u548C\u4F9B\u5E94,\u4EE5\u53CA\u82D7\u6728\u57F9\u80B2\u548C\u6797\u6728\u79CD\u690D\u7ECF\u8425\u7B49",
      products: [
        "\u9020\u7EB8\u4E1A\u52A1",
        "\u7BB1\u677F\u7EB8\u3001\u80F6\u7248\u7EB8\u3001\u5176\u4ED6\u7EB8\u5236\u54C1\u3001\u94DC\u7248\u7EB8\u3001\u6728\u6D46\u3001\u751F\u6D3B\u7528\u7EB8\u3001\u5176\u4ED6\u80FD\u6E90\u53D1\u7535\u3001\u6728\u6D46\u3001\u6728\u6D46\u3001\u6DCB\u819C\u539F\u7EB8\u3001\u74E6\u695E\u7EB8\u3001\u53CC\u6C27\u6C34\u3001\u5EFA\u7B51\u6750\u6599"
      ]
    },
    {
      code: "002080.SZ",
      name: "\u4E2D\u6750\u79D1\u6280",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102-\u73BB\u7EA4",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102",
        "\u73BB\u7EA4"
      ],
      mainBusiness: "\u56F4\u7ED5\u65B0\u80FD\u6E90\u3001\u65B0\u6750\u6599\u3001\u7EFF\u8272\u4F4E\u78B3\u7B49\u6218\u7565\u6027\u65B0\u5174\u4EA7\u4E1A\u65B9\u5411,\u805A\u7126\u7279\u79CD\u7EA4\u7EF4\u3001\u590D\u5408\u6750\u6599\u3001\u65B0\u80FD\u6E90\u6750\u6599\u4E09\u5927\u8D5B\u9053\u3001\u79C9\u6301\u201C\u505A\u4F18\u73BB\u7EA4\u3001\u505A\u5F3A\u53F6\u7247\u3001\u505A\u5927\u9502\u819C\u201D\u7684\u4EA7\u4E1A\u53D1\u5C55\u601D\u8DEF,\u96C6\u4E2D\u4F18\u52BF\u8D44\u6E90\u5927\u529B\u53D1\u5C55\u73BB\u7483\u7EA4\u7EF4\u53CA\u5236\u54C1\u3001\u98CE\u7535\u53F6\u7247\u3001\u9502\u7535\u6C60\u9694\u819C\u4E09\u5927\u4E3B\u5BFC\u4EA7\u4E1A,\u540C\u65F6\u4ECE\u4E8B\u9AD8\u538B\u590D\u5408\u6C14\u74F6\u3001\u819C\u6750\u6599\u53CA\u5176\u4ED6\u590D\u5408\u6750\u6599\u5236\u54C1\u7684\u7814\u53D1\u3001\u5236\u9020\u53CA\u9500\u552E\u3002",
      products: [
        "\u65E0\u78B1\u73BB\u7483\u7EA4\u7EF4\u53CA\u5236\u54C1",
        "\u98CE\u7535\u53F6\u7247\u3001\u73BB\u7483\u7EA4\u7EF4\u3001\u73BB\u7483\u7EA4\u7EF4\u3001\u9502\u7535\u6C60\u9694\u819C\u3001\u9AD8\u538B\u50A8\u8FD0\u8BBE\u5907\u3001\u590D\u5408\u6750\u6599\u3001\u5176\u4ED6\u7EA4\u7EF4"
      ]
    },
    {
      code: "002126.SZ",
      name: "\u94F6\u8F6E\u80A1\u4EFD",
      availability: "available",
      industry: "\u4EA4\u8FD0\u8BBE\u5907-\u6C7D\u8F66-\u6C7D\u8F66\u96F6\u90E8\u4EF6",
      industryLevels: [
        "\u4EA4\u8FD0\u8BBE\u5907",
        "\u6C7D\u8F66",
        "\u6C7D\u8F66\u96F6\u90E8\u4EF6"
      ],
      mainBusiness: "\u8282\u80FD\u3001\u51CF\u6392\u3001\u667A\u80FD\u3001\u5B89\u5168\u56DB\u6761\u4EA7\u54C1\u53D1\u5C55\u4E3B\u7EBF,\u4E13\u6CE8\u4E8E\u6CB9\u3001\u6C34\u3001\u6C14\u3001\u51B7\u5A92\u95F4\u7684\u70ED\u4EA4\u6362\u5668\u3001\u6C7D\u8F66\u7A7A\u8C03\u7B49\u70ED\u7BA1\u7406\u4EA7\u54C1\u4EE5\u53CA\u540E\u5904\u7406\u6392\u6C14\u7CFB\u7EDF\u76F8\u5173\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u70ED\u4EA4\u6362\u5668",
        "\u6C7D\u8F66\u6563\u70ED\u5668\u3001\u8D38\u6613\u516C\u53F8\u4E0E\u8D44\u672C\u54C1\u7ECF\u9500\u5546"
      ]
    },
    {
      code: "002138.SZ",
      name: "\u987A\u7EDC\u7535\u5B50",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u7814\u53D1\u3001\u8BBE\u8BA1\u3001\u751F\u4EA7\u3001\u9500\u552E\u65B0\u578B\u7CBE\u5BC6\u7535\u5B50\u5143\u5668\u4EF6;\u63D0\u4F9B\u6280\u672F\u89E3\u51B3\u65B9\u6848\u548C\u6280\u672F\u8F6C\u8BA9\u3001\u54A8\u8BE2\u670D\u52A1,\u9500\u552E\u81EA\u4EA7\u4EA7\u54C1\u3002",
      products: [
        "\u7247\u5F0F\u7535\u5B50\u5143\u4EF6",
        "\u88AB\u52A8\u5143\u4EF6"
      ]
    },
    {
      code: "002142.SZ",
      name: "\u5B81\u6CE2\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C"
      ],
      mainBusiness: "\u5BF9\u516C\u53CA\u5BF9\u79C1\u5B58\u6B3E\u3001\u8D37\u6B3E\u3001\u652F\u4ED8\u7ED3\u7B97\u3001\u8D44\u91D1\u4E1A\u52A1\u3001\u5E76\u63D0\u4F9B\u8D44\u4EA7\u7BA1\u7406\u53CA\u5176\u4ED6\u91D1\u878D\u4E1A\u52A1",
      products: [
        "\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C"
      ]
    },
    {
      code: "002156.SZ",
      name: "\u901A\u5BCC\u5FAE\u7535",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u96C6\u6210\u7535\u8DEF\u5C01\u88C5\u3001\u6D4B\u8BD5\u670D\u52A1",
      products: [
        "\u96C6\u6210\u7535\u8DEF\u5C01\u88C5\u6D4B\u8BD5",
        "\u96C6\u6210\u7535\u8DEF\u5C01\u6D4B\u670D\u52A1\u3001\u534A\u5BFC\u4F53\u5C01\u88C5\u6A21\u5177"
      ]
    },
    {
      code: "002179.SZ",
      name: "\u4E2D\u822A\u5149\u7535",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u4E2D\u9AD8\u7AEF\u5149\u3001\u7535\u3001\u6D41\u4F53\u8FDE\u63A5\u6280\u672F\u4E0E\u4EA7\u54C1\u7684\u7814\u7A76\u4E0E\u5F00\u53D1,\u4E13\u4E1A\u4E3A\u822A\u7A7A\u53CA\u9632\u52A1\u548C\u9AD8\u7AEF\u5236\u9020\u63D0\u4F9B\u4E92\u8FDE\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u7535\u8FDE\u63A5\u5668\u53CA\u96C6\u6210\u4E92\u8FDE\u7EC4\u4EF6",
        "\u8FDE\u63A5\u5668\u3001\u8FDE\u63A5\u5668"
      ]
    },
    {
      code: "002230.SZ",
      name: "\u79D1\u5927\u8BAF\u98DE",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u8F6F\u4EF6-\u884C\u4E1A\u5E94\u7528\u8F6F\u4EF6",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u8BA1\u7B97\u673A\u8F6F\u4EF6",
        "\u884C\u4E1A\u5E94\u7528\u8F6F\u4EF6"
      ],
      mainBusiness: "\u667A\u6167\u6559\u80B2\u4E1A\u52A1,\u667A\u6167\u533B\u7597\u4E1A\u52A1,\u667A\u6167\u57CE\u5E02\u4E1A\u52A1,\u5F00\u653E\u5E73\u53F0\u4E0E\u6D88\u8D39\u8005\u4E1A\u52A1,\u8FD0\u8425\u5546\u3001\u667A\u6167\u6C7D\u8F66\u3001\u667A\u6167\u91D1\u878D\u7B49\u4F01\u4E1A\u5BA2\u6237AI\u89E3\u51B3\u65B9\u6848\u4E1A\u52A1",
      products: [
        "\u6559\u80B2\u9886\u57DF",
        "\u6559\u80B2\u5E94\u7528\u8F6F\u4EF6\u3001\u8BED\u97F3\u8F6F\u4EF6\u3001\u667A\u80FD\u786C\u4EF6\u3001\u4FE1\u606F\u79D1\u6280\u5E94\u7528\u670D\u52A1\u3001\u7535\u5B50\u653F\u52A1\u5E94\u7528\u8F6F\u4EF6\u3001\u667A\u6167\u57CE\u5E02\u3001\u6C7D\u8F66\u7535\u5B50\u8F6F\u4EF6\u3001\u5E94\u7528\u8F6F\u4EF6\u3001\u4FE1\u606F\u79D1\u6280\u5E94\u7528\u670D\u52A1\u3001\u533B\u7597\u884C\u4E1A\u5E94\u7528\u8F6F\u4EF6\u3001\u7535\u5B50\u653F\u52A1\u5E94\u7528\u8F6F\u4EF6"
      ]
    },
    {
      code: "002281.SZ",
      name: "\u5149\u8FC5\u79D1\u6280",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8BBE\u5907-\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u901A\u4FE1\u8BBE\u5907",
        "\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907"
      ],
      mainBusiness: "\u5149\u7535\u5B50\u5668\u4EF6\u3001\u6A21\u5757\u548C\u5B50\u7CFB\u7EDF\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u53CA\u9500\u552E",
      products: [
        "\u63A5\u5165\u548C\u6570\u636E",
        "\u5149\u6A21\u5757\u3001\u5149\u901A\u4FE1\u5668\u4EF6"
      ]
    },
    {
      code: "002311.SZ",
      name: "\u6D77\u5927\u96C6\u56E2",
      availability: "available",
      industry: "\u519C\u6797\u7267\u6E14-\u755C\u7267\u4E1A-\u9972\u6599",
      industryLevels: [
        "\u519C\u6797\u7267\u6E14",
        "\u755C\u7267\u4E1A",
        "\u9972\u6599"
      ],
      mainBusiness: "\u9972\u6599\u3001\u9972\u6599\u539F\u6599\u8D38\u6613\u3001\u52A8\u4FDD\u3001\u755C\u79BD\u548C\u6C34\u4EA7\u517B\u6B96\u53CA\u8089\u98DF\u5C60\u5BB0\u52A0\u5DE5\u7B49\u4E1A\u52A1",
      products: [
        "\u9972\u6599",
        "\u9972\u6599\u3001\u755C\u79BD\u517B\u6B96\u3001\u9972\u6599\u539F\u6599\u7ECF\u9500\u5546\u3001\u517D\u836F"
      ]
    },
    {
      code: "002352.SZ",
      name: "\u987A\u4E30\u63A7\u80A1",
      availability: "available",
      industry: "\u4EA4\u901A\u8FD0\u8F93-\u7269\u6D41-\u7269\u6D41",
      industryLevels: [
        "\u4EA4\u901A\u8FD0\u8F93",
        "\u7269\u6D41",
        "\u7269\u6D41"
      ],
      mainBusiness: "\u901F\u8FD0\u7269\u6D41\u4E1A\u52A1\u4E3B\u8981\u5305\u62EC\u65F6\u6548\u5FEB\u9012\u3001\u7ECF\u6D4E\u5FEB\u9012\u3001\u5FEB\u8FD0\u3001\u51B7\u8FD0\u53CA\u533B\u836F\u3001\u540C\u57CE\u5373\u65F6\u914D\u9001;\u4F9B\u5E94\u94FE\u53CA\u56FD\u9645\u4E1A\u52A1\u4E3B\u8981\u5305\u62EC\u56FD\u9645\u5FEB\u9012\u3001\u56FD\u9645\u8D27\u8FD0\u53CA\u4EE3\u7406\u3001\u4F9B\u5E94\u94FE",
      products: [
        "\u5FEB\u9012\u3001\u4F9B\u5E94\u94FE\u7269\u6D41\u670D\u52A1\u3001\u5FEB\u9012"
      ]
    },
    {
      code: "002353.SZ",
      name: "\u6770\u745E\u80A1\u4EFD",
      availability: "available",
      industry: "\u5316\u77F3\u80FD\u6E90-\u77F3\u6CB9\u5929\u7136\u6C14-\u6CB9\u7530\u670D\u52A1",
      industryLevels: [
        "\u5316\u77F3\u80FD\u6E90",
        "\u77F3\u6CB9\u5929\u7136\u6C14",
        "\u6CB9\u7530\u670D\u52A1"
      ],
      mainBusiness: "\u9AD8\u7AEF\u88C5\u5907\u5236\u9020\u3001\u6CB9\u6C14\u5DE5\u7A0B\u53CA\u6280\u672F\u670D\u52A1\u3001\u6CB9\u6C14\u7530\u5F00\u53D1\u3001\u65B0\u80FD\u6E90\u53CA\u518D\u751F\u5FAA\u73AF\u7B49",
      products: [
        "\u9AD8\u7AEF\u88C5\u5907\u5236\u9020",
        "\u6CB9\u670D\u88C5\u5907\u3001\u6CB9\u6C14\u7530\u6280\u672F\u670D\u52A1\u3001\u73AF\u5883\u5DE5\u7A0B\u670D\u52A1\u3001\u6CB9\u6C14\u7530\u6280\u672F\u670D\u52A1"
      ]
    },
    {
      code: "002371.SZ",
      name: "\u5317\u65B9\u534E\u521B",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u6750\u6599"
      ],
      mainBusiness: "\u534A\u5BFC\u4F53\u57FA\u7840\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E\u548C\u6280\u672F\u670D\u52A1",
      products: [
        "\u7535\u5B50\u5DE5\u827A\u88C5\u5907",
        "\u534A\u5BFC\u4F53\u5236\u9020\u8BBE\u5907\u3001\u7535\u5B50\u5143\u4EF6"
      ]
    },
    {
      code: "002384.SZ",
      name: "\u4E1C\u5C71\u7CBE\u5BC6",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5668\u4EF6-\u5176\u4ED6\u7535\u5B50\u5668\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5668\u4EF6",
        "\u5176\u4ED6\u7535\u5B50\u5668\u4EF6"
      ],
      mainBusiness: "\u7535\u5B50\u7535\u8DEF\u3001\u5149\u6A21\u5757(\u542B\u5149\u82AF\u7247)\u3001\u7CBE\u5BC6\u7EC4\u4EF6\u3001\u5149\u7535\u663E\u793A\u6A21\u7EC4\u7684\u5168\u7403\u8BBE\u8BA1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u7535\u5B50\u7535\u8DEF\u4EA7\u54C1",
        "\u5370\u5236\u7535\u8DEF\u677F\u3001\u663E\u793A\u5668\u4EF6\u3001\u79FB\u52A8\u901A\u4FE1\u8BBE\u5907\u3001\u663E\u793A\u5668\u4EF6"
      ]
    },
    {
      code: "002407.SZ",
      name: "\u591A\u6C1F\u591A",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u539F\u6599-\u6C1F\u5316\u5DE5",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u5B66\u539F\u6599",
        "\u6C1F\u5316\u5DE5"
      ],
      mainBusiness: "\u9AD8\u6027\u80FD\u65E0\u673A\u6C1F\u5316\u7269\u3001\u7535\u5B50\u5316\u5B66\u54C1\u3001\u9502\u79BB\u5B50\u7535\u6C60\u53CA\u6750\u6599\u7B49\u9886\u57DF\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u65B0\u80FD\u6E90\u6750\u6599",
        "\u516D\u6C1F\u78F7\u9178\u9502\u3001\u9502\u79BB\u5B50\u7535\u6C60\u3001\u6C1F\u5316\u76D0\u3001\u6C1F\u5316\u76D0"
      ]
    },
    {
      code: "002409.SZ",
      name: "\u96C5\u514B\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u6750\u6599"
      ],
      mainBusiness: "\u7535\u5B50\u6750\u6599\u4E1A\u52A1,LNG\u4FDD\u6E29\u7EDD\u70ED\u677F\u6750\u4E1A\u52A1,\u963B\u71C3\u5242\u4E1A\u52A1",
      products: [
        "\u534A\u5BFC\u4F53\u5316\u5B66\u6750\u6599\u3001\u5149\u523B\u80F6\u53CA\u914D\u5957\u8BD5\u5242",
        "\u4FDD\u6E29\u6750\u6599\u3001\u534A\u5BFC\u4F53\u5C01\u88C5\u5316\u5B66\u54C1\u3001\u5149\u523B\u80F6\u3001\u79DF\u8D41\u670D\u52A1\u3001\u7535\u5B50\u7279\u6C14\u3001\u534A\u5BFC\u4F53\u8BBE\u5907\u3001\u7845\u5FAE\u7C89\u3001\u963B\u71C3\u5242"
      ]
    },
    {
      code: "002415.SZ",
      name: "\u6D77\u5EB7\u5A01\u89C6",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u786C\u4EF6-PC\u3001\u670D\u52A1\u5668\u53CA\u786C\u4EF6",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u8BA1\u7B97\u673A\u786C\u4EF6",
        "PC\u3001\u670D\u52A1\u5668\u53CA\u786C\u4EF6"
      ],
      mainBusiness: "\u5B89\u9632\u89C6\u9891\u76D1\u63A7\u4EA7\u54C1\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E,\u4EA7\u54C1\u5305\u62EC\u786C\u76D8\u5F55\u50CF\u673A(DVR)\u3001\u89C6\u97F3\u9891\u7F16\u89E3\u7801\u5361\u7B49\u6570\u636E\u5B58\u50A8\u53CA\u5904\u7406\u8BBE\u5907,\u4EE5\u53CA\u76D1\u63A7\u6444\u50CF\u673A\u3001\u76D1\u63A7\u7403\u673A\u3001\u89C6\u9891\u670D\u52A1\u5668(DVS)\u7B49\u89C6\u97F3\u9891\u4FE1\u606F\u91C7\u96C6\u5904\u7406\u8BBE\u5907\u3002",
      products: [
        "\u4EA7\u54C1\u53CA\u670D\u52A1",
        "\u667A\u80FD\u5B89\u9632\u4EA7\u54C1\u3001\u667A\u80FD\u5B89\u9632\u4EA7\u54C1\u3001\u5B89\u9632\u76D1\u63A7\u7CFB\u7EDF\u96C6\u6210"
      ]
    },
    {
      code: "002422.SZ",
      name: "\u79D1\u4F26\u836F\u4E1A",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u5316\u5B66\u5236\u836F-\u5316\u5B66\u5236\u5242",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u5316\u5B66\u5236\u836F",
        "\u5316\u5B66\u5236\u5242"
      ],
      mainBusiness: "\u5927\u5BB9\u91CF\u6CE8\u5C04\u5242(\u8F93\u6DB2)\u3001\u5C0F\u5BB9\u91CF\u6CE8\u5C04\u5242(\u6C34\u9488)\u3001\u6CE8\u5C04\u7528\u65E0\u83CC\u7C89\u9488(\u542B\u5206\u88C5\u7C89\u9488\u53CA\u51BB\u5E72\u7C89\u9488)\u3001\u7247\u5242\u3001\u80F6\u56CA\u5242\u3001\u9897\u7C92\u5242\u3001\u53E3\u670D\u6DB2\u3001\u8179\u819C\u900F\u6790\u6DB2\u7B4923\u79CD\u5242\u578B\u836F\u54C1\u53CA\u6297\u751F\u7D20\u4E2D\u95F4\u4F53\u3001\u539F\u6599\u836F\u3001\u533B\u836F\u5305\u6750\u7B49\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u8F93\u6DB2",
        "\u5176\u4ED6\u751F\u7269\u53CA\u5316\u5B66\u836F\u3001\u5927\u8F93\u6DB2\u3001CRO"
      ]
    },
    {
      code: "002428.SZ",
      name: "\u4E91\u5357\u9517\u4E1A",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u5176\u4ED6\u7A00\u6709\u5C0F\u91D1\u5C5E",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u7A00\u6709\u91D1\u5C5E",
        "\u5176\u4ED6\u7A00\u6709\u5C0F\u91D1\u5C5E"
      ],
      mainBusiness: "\u9517\u77FF\u5F00\u91C7\u3001\u706B\u6CD5\u5BCC\u96C6\u3001\u6E7F\u6CD5\u63D0\u7EAF\u3001\u533A\u7194\u7CBE\u70BC\u3001\u7CBE\u6DF1\u52A0\u5DE5\u53CA\u7814\u7A76\u5F00\u53D1",
      products: [
        "\u5149\u4F0F\u7EA7\u9517\u4EA7\u54C1",
        "\u9517\u3001\u9517\u52A0\u5DE5\u4EA7\u54C1\u3001\u9517\u52A0\u5DE5\u4EA7\u54C1\u3001\u5316\u5408\u7269\u534A\u5BFC\u4F53\u3001\u9517\u52A0\u5DE5\u4EA7\u54C1"
      ]
    },
    {
      code: "002436.SZ",
      name: "\u5174\u68EE\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u4E13\u6CE8\u4E8E\u5370\u5236\u7535\u8DEF\u677F\u4EA7\u4E1A\u94FE,\u56F4\u7ED5\u4F20\u7EDFPCB\u4E1A\u52A1\u3001\u534A\u5BFC\u4F53\u4E1A\u52A1\u4E24\u5927\u4E3B\u7EBF\u5F00\u5C55",
      products: [
        "PCB\u5370\u5236\u7535\u8DEF\u677F",
        "\u5370\u5236\u7535\u8DEF\u677F\u3001\u5C01\u88C5\u57FA\u677F\u3001\u534A\u5BFC\u4F53\u6D4B\u8BD5\u677F"
      ]
    },
    {
      code: "002460.SZ",
      name: "\u8D63\u950B\u9502\u4E1A",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u9502",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u7A00\u6709\u91D1\u5C5E",
        "\u9502"
      ],
      mainBusiness: "\u8D2F\u7A7F\u4E0A\u6E38\u9502\u8D44\u6E90\u5F00\u53D1\u3001\u4E2D\u6E38\u9502\u76D0\u6DF1\u52A0\u5DE5\u53CA\u91D1\u5C5E\u9502\u51B6\u70BC\u3001\u4E0B\u6E38\u9502\u7535\u6C60\u5236\u9020\u53CA\u9000\u5F79\u9502\u7535\u6C60\u7EFC\u5408\u56DE\u6536\u5229\u7528",
      products: [
        "\u9502\u7CFB\u5217\u4EA7\u54C1",
        "\u9502\u76D0\u3001\u9502\u79BB\u5B50\u7535\u6C60"
      ]
    },
    {
      code: "002463.SZ",
      name: "\u6CAA\u7535\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u5370\u5236\u7535\u8DEF\u677F\u3001\u623F\u5C4B\u9500\u552E\u3001\u7269\u4E1A\u8D39",
      products: [
        "\u4EA7\u54C1\u9500\u552E(\u5370\u5236\u7535\u8DEF\u677F\u4E1A\u52A1)",
        "\u5370\u5236\u7535\u8DEF\u677F\u3001\u5370\u5236\u7535\u8DEF\u677F\u3001\u5370\u5236\u7535\u8DEF\u677F"
      ]
    },
    {
      code: "002466.SZ",
      name: "\u5929\u9F50\u9502\u4E1A",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u9502",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u7A00\u6709\u91D1\u5C5E",
        "\u9502"
      ],
      mainBusiness: "\u786C\u5CA9\u578B\u9502\u77FF\u8D44\u6E90\u7684\u5F00\u53D1\u3001\u9502\u7CBE\u77FF\u751F\u4EA7\u9500\u552E\u4EE5\u53CA\u9502\u5316\u5DE5\u4EA7\u54C1\u7684\u751F\u4EA7\u9500\u552E,\u4E3A\u6E05\u6D01\u80FD\u6E90\u7684\u8F6C\u578B\u53D1\u5C55\u63D0\u4F9B\u53EF\u6301\u7EED\u3001\u9AD8\u8D28\u91CF\u7684\u9502\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u9502\u7CBE\u77FF",
        "\u9502\u76D0\u3001\u9502\u77FF"
      ]
    },
    {
      code: "002475.SZ",
      name: "\u7ACB\u8BAF\u7CBE\u5BC6",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u6D88\u8D39\u7535\u5B50\u8BBE\u5907-\u6D88\u8D39\u7535\u5B50\u8BBE\u5907",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u6D88\u8D39\u7535\u5B50\u8BBE\u5907",
        "\u6D88\u8D39\u7535\u5B50\u8BBE\u5907"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u6D88\u8D39\u7535\u5B50\u3001\u901A\u4FE1\u53CA\u6570\u636E\u4E2D\u5FC3\u3001\u6C7D\u8F66\u3001\u533B\u7597\u7B49\u9886\u57DF\u76F8\u5173\u96F6\u7EC4\u4EF6\u3001\u6A21\u7EC4\u53CA\u7CFB\u7EDF\u96C6\u6210\u4E1A\u52A1",
      products: [
        "\u6D88\u8D39\u6027\u7535\u5B50",
        "\u6D88\u8D39\u7535\u5B50\u8FDE\u63A5\u5668\u3001\u7535\u5B50\u7CBE\u5BC6\u7ED3\u6784\u4EF6\u3001\u7535\u5B50\u7CBE\u5BC6\u7ED3\u6784\u4EF6\u3001\u8FDE\u63A5\u5668"
      ]
    },
    {
      code: "002484.SZ",
      name: "\u6C5F\u6D77\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u94DD\u7535\u89E3\u7535\u5BB9\u5668(\u53CA\u6838\u5FC3\u6750\u6599)\u3001\u8584\u819C\u7535\u5BB9\u5668\u3001\u8D85\u7EA7\u7535\u5BB9\u5668",
      products: [
        "\u7535\u5BB9\u5668",
        "\u7535\u89E3\u7535\u5BB9\u5668\u3001\u8584\u819C\u7535\u5BB9\u5668\u3001\u8D85\u7EA7\u7535\u5BB9\u5668\u3001\u7535\u6781\u7B94"
      ]
    },
    {
      code: "002558.SZ",
      name: "\u5DE8\u4EBA\u7F51\u7EDC",
      availability: "available",
      industry: "\u4E92\u8054\u7F51-\u4E92\u8054\u7F51\u670D\u52A1-\u6E38\u620F\u5A31\u4E50",
      industryLevels: [
        "\u4E92\u8054\u7F51",
        "\u4E92\u8054\u7F51\u670D\u52A1",
        "\u6E38\u620F\u5A31\u4E50"
      ],
      mainBusiness: "\u4E92\u8054\u7F51\u6E38\u620F\u7684\u7814\u53D1\u548C\u8FD0\u8425",
      products: [
        "\u79FB\u52A8\u7AEF\u7F51\u7EDC\u6E38\u620F",
        "\u79FB\u52A8\u7EC8\u7AEF\u7F51\u7EDC\u6E38\u620F\u3001\u7F51\u7EDC\u6E38\u620F\u3001\u7F51\u7EDC\u6E38\u620F\u8FD0\u8425"
      ]
    },
    {
      code: "002594.SZ",
      name: "\u6BD4\u4E9A\u8FEA",
      availability: "available",
      industry: "\u4EA4\u8FD0\u8BBE\u5907-\u6C7D\u8F66-\u4E58\u7528\u8F66",
      industryLevels: [
        "\u4EA4\u8FD0\u8BBE\u5907",
        "\u6C7D\u8F66",
        "\u4E58\u7528\u8F66"
      ],
      mainBusiness: "\u4ECE\u4E8B\u4EE5\u65B0\u80FD\u6E90\u6C7D\u8F66\u4E3A\u4E3B\u7684\u6C7D\u8F66\u4E1A\u52A1,\u624B\u673A\u90E8\u4EF6\u53CA\u7EC4\u88C5\u4E1A\u52A1,\u4E8C\u6B21\u5145\u7535\u7535\u6C60\u53CA\u5149\u4F0F\u4E1A\u52A1,\u540C\u65F6\u5229\u7528\u81EA\u8EAB\u7684\u6280\u672F\u4F18\u52BF\u62D3\u5C55\u57CE\u5E02\u8F68\u9053\u4EA4\u901A\u4E1A\u52A1\u9886\u57DF",
      products: [
        "\u6C7D\u8F66\u3001\u6C7D\u8F66\u76F8\u5173\u4EA7\u54C1\u53CA\u5176\u4ED6\u4EA7\u54C1",
        "\u65B0\u80FD\u6E90\u6C7D\u8F66\u3001\u624B\u673A\u96F6\u4EF6"
      ]
    },
    {
      code: "002595.SZ",
      name: "\u8C6A\u8FC8\u79D1\u6280",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u4E13\u7528\u8BBE\u5907-\u5176\u4ED6\u4E13\u7528\u673A\u68B0",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u4E13\u7528\u8BBE\u5907",
        "\u5176\u4ED6\u4E13\u7528\u673A\u68B0"
      ],
      mainBusiness: "\u5B50\u5348\u7EBF\u8F6E\u80CE\u6D3B\u7EDC\u6A21\u5177\u7684\u751F\u4EA7\u53CA\u9500\u552E\u3001\u5927\u578B\u96F6\u90E8\u4EF6\u673A\u68B0\u4EA7\u54C1\u7684\u94F8\u9020\u53CA\u7CBE\u52A0\u5DE5\u3001\u673A\u5E8A\u88C5\u5907\u76F8\u5173\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u6A21\u5177",
        "\u6A21\u5177\u3001\u901A\u7528\u673A\u68B0\u8F85\u914D\u4EF6\u3001\u6570\u63A7\u673A\u5E8A"
      ]
    },
    {
      code: "002602.SZ",
      name: "\u4E16\u7EAA\u534E\u901A",
      availability: "available",
      industry: "\u4E92\u8054\u7F51-\u4E92\u8054\u7F51\u670D\u52A1-\u6E38\u620F\u5A31\u4E50",
      industryLevels: [
        "\u4E92\u8054\u7F51",
        "\u4E92\u8054\u7F51\u670D\u52A1",
        "\u6E38\u620F\u5A31\u4E50"
      ],
      mainBusiness: "\u4E3B\u8981\u5206\u4E3A\u4E92\u8054\u7F51\u6E38\u620F\u3001\u6C7D\u8F66\u96F6\u90E8\u4EF6\u5236\u9020\u548C\u4E91\u6570\u636E\u4E09\u4E2A\u677F\u5757",
      products: [
        "\u79FB\u52A8\u7F51\u7EDC\u6E38\u620F",
        "\u79FB\u52A8\u7EC8\u7AEF\u7F51\u7EDC\u6E38\u620F\u3001\u7F51\u7EDC\u6E38\u620F\u3001\u5176\u4ED6\u6C7D\u8F66\u96F6\u4EF6\u4E0E\u8BBE\u5907\u3001\u7F51\u9875\u6E38\u620F\u3001IDC\u6570\u636E\u4E2D\u5FC3\u670D\u52A1"
      ]
    },
    {
      code: "002653.SZ",
      name: "\u6D77\u601D\u79D1",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u5316\u5B66\u5236\u836F-\u5316\u5B66\u5236\u5242",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u5316\u5B66\u5236\u836F",
        "\u5316\u5B66\u5236\u5242"
      ],
      mainBusiness: "\u6D77\u601D\u79D1\u662F\u96C6\u65B0\u836F\u7814\u53D1\u3001\u751F\u4EA7\u5236\u9020\u3001\u63A8\u5E7F\u8425\u9500\u4E1A\u52A1\u4E8E\u4E00\u4F53\u7684\u4E13\u4E1A\u5316\u533B\u836F\u516C\u53F8,\u81F4\u529B\u4E8E\u6210\u4E3A\u6700\u53D7\u4FE1\u8D56\u7684\u56FD\u9645\u5316\u5236\u836F\u4F01\u4E1A\u3002\u516C\u53F8\u4EE5\u201C\u521B\u65B0\u201D\u4E3A\u5185\u6838,\u4EE5\u201C\u4EE5\u594B\u6597\u4E4B\u5FC3,\u4E0E\u751F\u547D\u540C\u884C\u201D\u4E3A\u4F7F\u547D,\u59CB\u7EC8\u4EE5\u5BA2\u6237\u9700\u6C42\u4E3A\u5BFC\u5411,\u4E0D\u65AD\u4E3A\u5BA2\u6237\u63D0\u4F9B\u521B\u65B0\u7279\u8272\u4E13\u79D1\u9886\u57DF\u7684\u836F\u7269\u4EA7\u54C1",
      products: [
        "\u81EA\u4EA7\u4EA7\u54C1\u6536\u5165",
        "\u5316\u836F\u5236\u5242"
      ]
    },
    {
      code: "002709.SZ",
      name: "\u5929\u8D50\u6750\u6599",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u91D1\u5C5E\u975E\u91D1\u5C5E\u65B0\u6750\u6599-\u7535\u6C60\u6750\u6599",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u91D1\u5C5E\u975E\u91D1\u5C5E\u65B0\u6750\u6599",
        "\u7535\u6C60\u6750\u6599"
      ],
      mainBusiness: "\u7CBE\u7EC6\u5316\u5DE5\u65B0\u6750\u6599\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E\u3002",
      products: [
        "\u9502\u79BB\u5B50\u7535\u6C60\u6750\u6599\u4EA7\u54C1",
        "\u7535\u89E3\u6DB2\u3001\u65E5\u7528\u5316\u5B66\u54C1"
      ]
    },
    {
      code: "002714.SZ",
      name: "\u7267\u539F\u80A1\u4EFD",
      availability: "available",
      industry: "\u519C\u6797\u7267\u6E14-\u755C\u7267\u4E1A-\u517B\u6B96",
      industryLevels: [
        "\u519C\u6797\u7267\u6E14",
        "\u755C\u7267\u4E1A",
        "\u517B\u6B96"
      ],
      mainBusiness: "\u751F\u732A\u7684\u517B\u6B96\u9500\u552E\u3001\u751F\u732A\u5C60\u5BB0",
      products: [
        "\u751F\u732A",
        "\u751F\u732A\u3001\u8089\u5236\u54C1\u3001\u9972\u6599\u539F\u6599\u7ECF\u9500\u5546"
      ]
    },
    {
      code: "002731.SZ",
      name: "*ST\u8403\u534E",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u8D35\u91D1\u5C5E-\u9EC4\u91D1",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u8D35\u91D1\u5C5E",
        "\u9EC4\u91D1"
      ],
      mainBusiness: "\u73E0\u5B9D\u9970\u54C1\u8BBE\u8BA1\u3001\u52A0\u5DE5\u3001\u6279\u53D1\u548C\u96F6\u552E\u548C\u9502\u76D0\u4EA7\u54C1\u7684\u751F\u4EA7\u3001\u9500\u552E\u548C\u52A0\u5DE5",
      products: [
        "\u91D1\u9996\u9970\u3001\u9502\u3001\u73E0\u5B9D\u9996\u9970\u3001\u73E0\u5B9D\u9996\u9970\u3001\u94C2\u9996\u9970"
      ]
    },
    {
      code: "002821.SZ",
      name: "\u51EF\u83B1\u82F1",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u5316\u5B66\u5236\u836F-\u5316\u5B66\u539F\u6599\u836F",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u5316\u5B66\u5236\u836F",
        "\u5316\u5B66\u539F\u6599\u836F"
      ],
      mainBusiness: "\u5168\u7403\u5236\u836F\u5DE5\u827A\u7684\u6280\u672F\u521B\u65B0\u548C\u5546\u4E1A\u5316\u5E94\u7528",
      products: [
        "\u5C0F\u5206\u5B50CDMO\u89E3\u51B3\u65B9\u6848",
        "\u533B\u836FCDMO\u3001CRO"
      ]
    },
    {
      code: "002831.SZ",
      name: "\u88D5\u540C\u79D1\u6280",
      availability: "available",
      industry: "\u8F7B\u5DE5\u5236\u9020-\u9020\u7EB8\u5370\u5237-\u5305\u88C5\u5370\u5237",
      industryLevels: [
        "\u8F7B\u5DE5\u5236\u9020",
        "\u9020\u7EB8\u5370\u5237",
        "\u5305\u88C5\u5370\u5237"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u7EB8\u8D28\u5370\u5237\u5305\u88C5\u4EA7\u54C1\u53CA\u690D\u7269\u7EA4\u7EF4\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E,\u5E76\u4E3A\u5BA2\u6237\u63D0\u4F9B\u521B\u610F\u8BBE\u8BA1\u3001\u7ED3\u6784\u8BBE\u8BA1\u3001\u6280\u672F\u5F00\u53D1\u3001\u4EA7\u54C1\u6253\u6837\u3001\u8272\u5F69\u7BA1\u7406\u3001\u7B2C\u4E09\u65B9\u91C7\u8D2D\u3001\u4ED3\u50A8\u7BA1\u7406\u548C\u7269\u6D41\u914D\u9001\u7B49\u4E00\u4F53\u5316\u6DF1\u5EA6\u670D\u52A1",
      products: [
        "\u7EB8\u5236\u7CBE\u54C1\u5305\u88C5",
        "\u7EB8\u6750\u6599\u5305\u88C5\u3001\u7EB8\u6750\u6599\u5305\u88C5\u3001\u5176\u4ED6\u7EB8\u6750\u6599\u5305\u88C5"
      ]
    },
    {
      code: "002832.SZ",
      name: "\u6BD4\u97F3\u52D2\u82AC",
      availability: "available",
      industry: "\u7EBA\u7EC7\u670D\u88C5-\u670D\u88C5\u5BB6\u7EBA-\u670D\u88C5",
      industryLevels: [
        "\u7EBA\u7EC7\u670D\u88C5",
        "\u670D\u88C5\u5BB6\u7EBA",
        "\u670D\u88C5"
      ],
      mainBusiness: "\u4EE5\u670D\u9970\u7814\u53D1\u8BBE\u8BA1\u3001\u54C1\u724C\u8FD0\u8425\u53CA\u6570\u5B57\u5316\u8FD0\u8425\u3001\u8425\u9500\u7F51\u7EDC\u5EFA\u8BBE\u53CA\u4F9B\u5E94\u94FE\u7BA1\u7406\u4E3A\u4E3B\u8981\u4E1A\u52A1",
      products: [
        "\u4E0A\u88C5\u7C7B",
        "\u8FD0\u52A8\u670D\u88C5\u3001\u8FD0\u52A8\u670D\u88C5\u3001\u8FD0\u52A8\u670D\u88C5\u3001\u8FD0\u52A8\u670D\u88C5"
      ]
    },
    {
      code: "002850.SZ",
      name: "\u79D1\u8FBE\u5229",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u91D1\u5C5E\u5236\u54C1-\u91D1\u5C5E\u5236\u54C1",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u91D1\u5C5E\u5236\u54C1",
        "\u91D1\u5C5E\u5236\u54C1"
      ],
      mainBusiness: "\u9502\u7535\u6C60\u7CBE\u5BC6\u7ED3\u6784\u4EF6\u4E1A\u52A1\u3001\u6C7D\u8F66\u7ED3\u6784\u4EF6\u4E1A\u52A1",
      products: [
        "\u9502\u7535\u6C60\u7ED3\u6784\u4EF6",
        "\u7535\u6C60\u7ED3\u6784\u4EF6\u3001\u7535\u6C60\u7ED3\u6784\u4EF6\u3001\u7535\u6C60\u7ED3\u6784\u4EF6"
      ]
    },
    {
      code: "002851.SZ",
      name: "\u9EA6\u683C\u7C73\u7279",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u5176\u4ED6\u7535\u6C14\u8BBE\u5907-\u5176\u4ED6\u7535\u6C14\u8BBE\u5907",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u5176\u4ED6\u7535\u6C14\u8BBE\u5907",
        "\u5176\u4ED6\u7535\u6C14\u8BBE\u5907"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u667A\u80FD\u5BB6\u7535\u7535\u63A7\u4EA7\u54C1\u3001\u7535\u6E90\u4EA7\u54C1\u3001\u65B0\u80FD\u6E90\u53CA\u8F68\u9053\u4EA4\u901A\u90E8\u4EF6\u3001\u5DE5\u4E1A\u81EA\u52A8\u5316\u4EA7\u54C1\u3001\u667A\u80FD\u88C5\u5907\u548C\u7CBE\u5BC6\u8FDE\u63A5\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u667A\u80FD\u5BB6\u7535\u7535\u63A7\u4EA7\u54C1",
        "\u5BB6\u7535\u96F6\u90E8\u4EF6\u3001\u5176\u4ED6\u7535\u6E90\u8BBE\u5907\u3001\u8F68\u9053\u4EA4\u901A\u8F66\u8F7D\u7535\u6C14\u63A7\u5236\u7C7B\u96F6\u90E8\u4EF6\u3001\u5DE5\u4E1A\u81EA\u52A8\u5316\u8BBE\u5907\u3001\u901A\u7528\u8BBE\u5907\u3001\u8FDE\u63A5\u5668"
      ]
    },
    {
      code: "002859.SZ",
      name: "\u6D01\u7F8E\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u7535\u5B50\u5C01\u88C5\u6750\u6599\u53CA\u7535\u5B50\u7EA7\u8584\u819C\u6750\u6599\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u7535\u5B50\u5C01\u88C5\u6750\u6599",
        "\u7535\u5B50\u5C01\u88C5\u6750\u6599\u3001\u5176\u4ED6\u8584\u819C"
      ]
    },
    {
      code: "002916.SZ",
      name: "\u6DF1\u5357\u7535\u8DEF",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u4E13\u6CE8\u4E8E\u7535\u5B50\u4E92\u8054\u9886\u57DF,\u81F4\u529B\u4E8E\u201C\u6253\u9020\u4E16\u754C\u7EA7\u7535\u5B50\u7535\u8DEF\u6280\u672F\u4E0E\u89E3\u51B3\u65B9\u6848\u7684\u96C6\u6210\u5546\u201D,\u62E5\u6709\u5370\u5236\u7535\u8DEF\u677F\u3001\u7535\u5B50\u88C5\u8054\u3001\u5C01\u88C5\u57FA\u677F\u4E09\u9879\u4E3B\u8425\u4E1A\u52A1",
      products: [
        "\u5370\u5236\u7535\u8DEF\u677F",
        "\u5370\u5236\u7535\u8DEF\u677F\u3001\u5C01\u88C5\u57FA\u677F\u3001\u7535\u5B50\u5236\u9020\u670D\u52A1"
      ]
    },
    {
      code: "002938.SZ",
      name: "\u9E4F\u9F0E\u63A7\u80A1",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u5404\u7C7B\u5370\u5236\u7535\u8DEF\u677F\u7684\u7814\u53D1\u3001\u8BBE\u8BA1\u3001\u5236\u9020\u3001\u9500\u552E\u4E0E\u670D\u52A1\u4E3A\u4E00\u4F53\u7684\u4E13\u4E1A\u5927\u578B\u5382\u5546,\u4E13\u6CE8\u4E8E\u4E3A\u884C\u4E1A\u9886\u5148\u5BA2\u6237\u63D0\u4F9B\u5168\u65B9\u4F4DPCB\u4EA7\u54C1\u53CA\u670D\u52A1,\u6839\u636E\u4E0B\u6E38\u4E0D\u540C\u7EC8\u7AEF\u4EA7\u54C1\u5BF9\u4E8EPCB\u7684\u5B9A\u5236\u5316\u8981\u6C42,\u4E3A\u5BA2\u6237\u63D0\u4F9B\u6DB5\u76D6PCB\u4EA7\u54C1\u7814\u53D1\u3001\u8BBE\u8BA1\u3001\u5236\u9020\u4E0E\u9500\u552E\u670D\u52A1\u5404\u4E2A\u73AF\u8282\u7684\u6574\u4F53\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u901A\u8BAF\u7528\u677F",
        "\u5370\u5236\u7535\u8DEF\u677F\u3001\u5370\u5236\u7535\u8DEF\u677F\u3001\u5370\u5236\u7535\u8DEF\u677F"
      ]
    },
    {
      code: "300014.SZ",
      name: "\u4EBF\u7EAC\u9502\u80FD",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u7535\u6E90\u8BBE\u5907-\u50A8\u80FD\u8BBE\u5907",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u7535\u6E90\u8BBE\u5907",
        "\u50A8\u80FD\u8BBE\u5907"
      ],
      mainBusiness: "\u6D88\u8D39\u7535\u6C60(\u5305\u62EC\u9502\u539F\u7535\u6C60\u3001\u5C0F\u578B\u9502\u79BB\u5B50\u7535\u6C60\u3001\u5706\u67F1\u7535\u6C60)\u3001\u52A8\u529B\u7535\u6C60(\u5305\u62EC\u65B0\u80FD\u6E90\u6C7D\u8F66\u7535\u6C60\u53CA\u5176\u7535\u6C60\u7CFB\u7EDF)\u548C\u50A8\u80FD\u7535\u6C60\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E\u3002",
      products: [
        "\u9502\u79BB\u5B50\u7535\u6C60",
        "\u52A8\u529B\u7535\u6C60\u7CFB\u7EDF\u3001\u50A8\u80FD\u7535\u6C60\u7CFB\u7EDF\u3001\u6D88\u8D39\u7C7B\u9502\u79BB\u5B50\u7535\u6C60"
      ]
    },
    {
      code: "300033.SZ",
      name: "\u540C\u82B1\u987A",
      availability: "available",
      industry: "\u4E92\u8054\u7F51-\u4E92\u8054\u7F51\u91D1\u878D-\u5176\u4ED6\u4E92\u8054\u7F51\u91D1\u878D",
      industryLevels: [
        "\u4E92\u8054\u7F51",
        "\u4E92\u8054\u7F51\u91D1\u878D",
        "\u5176\u4ED6\u4E92\u8054\u7F51\u91D1\u878D"
      ],
      mainBusiness: "\u56FD\u5185\u9886\u5148\u7684\u4E92\u8054\u7F51\u91D1\u878D\u4FE1\u606F\u670D\u52A1\u63D0\u4F9B\u5546,\u56F4\u7ED5\u8D44\u672C\u5E02\u573A\u751F\u6001\u6253\u9020\u201CAI+\u91D1\u878D\u4FE1\u606F\u670D\u52A1\u201D\u4E00\u4F53\u5316\u5E73\u53F0,\u670D\u52A1\u5BF9\u8C61\u8986\u76D6\u8BC1\u5238\u516C\u53F8\u3001\u57FA\u91D1\u516C\u53F8\u3001\u94F6\u884C\u3001\u4FDD\u9669\u673A\u6784\u3001\u653F\u5E9C\u90E8\u95E8\u3001\u7814\u7A76\u673A\u6784\u3001\u4E0A\u5E02\u516C\u53F8\u7B49\u673A\u6784\u5BA2\u6237\u53CA\u5E7F\u5927\u4E2A\u4EBA\u6295\u8D44\u8005\u3002\u4F9D\u6258\u957F\u671F\u79EF\u7D2F\u7684\u91D1\u878D\u6570\u636E\u8D44\u6E90\u3001\u6280\u672F\u80FD\u529B\u4E0E\u7528\u6237\u57FA\u7840,\u516C\u53F8\u6301\u7EED\u63A8\u8FDB\u4EBA\u5DE5\u667A\u80FD\u6280\u672F\u4E0E\u4E3B\u8425\u4E1A\u52A1\u6DF1\u5EA6\u878D\u5408,\u52A0\u5FEB\u5411AI\u9A71\u52A8\u578B\u91D1\u878D\u79D1\u6280\u5E73\u53F0\u8F6C\u578B\u5347\u7EA7",
      products: [
        "\u5E7F\u544A\u53CA\u4E92\u8054\u7F51\u4E1A\u52A1\u63A8\u5E7F\u670D\u52A1",
        "\u7F51\u7EDC\u5E7F\u544A\u5E73\u53F0\u63D0\u4F9B\u5546\u3001\u91D1\u878D\u4FE1\u606F\u670D\u52A1\u3001\u91D1\u878D\u884C\u4E1A\u5E94\u7528\u8F6F\u4EF6\u3001\u91D1\u878D\u4EA7\u54C1\u4EE3\u9500\u670D\u52A1"
      ]
    },
    {
      code: "300037.SZ",
      name: "\u65B0\u5B99\u90A6",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u5236\u54C1-\u5176\u4ED6\u5316\u5B66\u5236\u54C1",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u5B66\u5236\u54C1",
        "\u5176\u4ED6\u5316\u5B66\u5236\u54C1"
      ],
      mainBusiness: "\u65B0\u578B\u7535\u5B50\u5316\u5B66\u54C1\u53CA\u529F\u80FD\u6750\u6599\u7684\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E\u548C\u670D\u52A1",
      products: [
        "\u6709\u673A\u6C1F\u5316\u5B66\u54C1",
        "\u7535\u89E3\u6DB2\u3001\u7535\u5B50\u5316\u5B66\u54C1\u3001\u542B\u6C1F\u4E2D\u95F4\u4F53"
      ]
    },
    {
      code: "300054.SZ",
      name: "\u9F0E\u9F99\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u6750\u6599"
      ],
      mainBusiness: "\u534A\u5BFC\u4F53\u4E1A\u52A1,\u6253\u5370\u590D\u5370\u901A\u7528\u8017\u6750\u4E1A\u52A1",
      products: [
        "\u534A\u5BFC\u4F53\u6750\u6599\u3001\u82AF\u7247\u53CA\u6253\u5370\u590D\u5370\u901A\u7528\u8017\u6750\u4EA7\u54C1(\u542BCMP\u629B\u5149\u57AB\u3001CMP\u629B\u5149\u6DB2\u3001CMP\u6E05\u6D17\u6DB2\u3001YPI\u3001PSPI\u3001TFEINK\u3001\u4E34\u65F6\u952E\u5408\u80F6\u3001\u534A\u5BFC\u4F53\u5C01\u88C5PI\u3001\u82AF\u7247,\u4EE5\u53CA\u5F69\u8272\u805A\u5408\u78B3\u7C89\u3001\u663E\u5F71\u8F8A\u3001\u8F7D\u4F53\u3001\u7852\u9F13\u3001\u58A8\u76D2\u7B49)",
        "\u534A\u5BFC\u4F53\u5236\u9020\u6750\u6599\u3001\u6253\u5370\u673A\u53CA\u5176\u96F6\u90E8\u4EF6"
      ]
    },
    {
      code: "300059.SZ",
      name: "\u4E1C\u65B9\u8D22\u5BCC",
      availability: "available",
      industry: "\u4E92\u8054\u7F51-\u4E92\u8054\u7F51\u91D1\u878D-\u5176\u4ED6\u4E92\u8054\u7F51\u91D1\u878D",
      industryLevels: [
        "\u4E92\u8054\u7F51",
        "\u4E92\u8054\u7F51\u91D1\u878D",
        "\u5176\u4ED6\u4E92\u8054\u7F51\u91D1\u878D"
      ],
      mainBusiness: "\u8BC1\u5238\u4E1A\u52A1\u3001\u91D1\u878D\u7535\u5B50\u5546\u52A1\u670D\u52A1\u4E1A\u52A1\u3001\u91D1\u878D\u6570\u636E\u670D\u52A1\u4E1A\u52A1\u7B49",
      products: [
        "\u91D1\u878D\u7535\u5B50\u5546\u52A1\u670D\u52A1",
        "\u8BC1\u5238\u3001\u7535\u5546\u670D\u52A1\u3001\u91D1\u878D\u4FE1\u606F\u670D\u52A1"
      ]
    },
    {
      code: "300124.SZ",
      name: "\u6C47\u5DDD\u6280\u672F",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u673A\u5668\u4EBA-\u5DE5\u4E1A\u673A\u5668\u4EBA",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u673A\u5668\u4EBA",
        "\u5DE5\u4E1A\u673A\u5668\u4EBA"
      ],
      mainBusiness: "\u5DE5\u4E1A\u81EA\u52A8\u5316\u4E0E\u6570\u5B57\u5316\u4E1A\u52A1:\u5305\u62EC\u901A\u7528\u81EA\u52A8\u5316\u3001\u667A\u6167\u7535\u68AF\u3001\u6570\u5B57\u5316\u7B49\u4EA7\u54C1\u53CA\u89E3\u51B3\u65B9\u6848;\u65B0\u80FD\u6E90\u6C7D\u8F66\u52A8\u529B\u7CFB\u7EDF\u4E1A\u52A1:\u5305\u62EC\u7535\u9A71\u7CFB\u7EDF(\u7535\u63A7\u3001\u7535\u673A\u3001\u9A71\u52A8\u603B\u6210)\u3001\u7535\u6E90\u7CFB\u7EDF(OBC\u3001DC/DC\u3001\u7535\u6E90\u603B\u6210)\u548C\u667A\u80FD\u5E95\u76D8\u7CFB\u7EDF(\u4E3B\u52A8\u60AC\u67B6\u6DB2\u538B\u6CF5\u3001\u4E3B\u52A8\u7A33\u5B9A\u6746)\u7B49\u4EA7\u54C1\u3001\u670D\u52A1\u53CA\u89E3\u51B3\u65B9\u6848;\u65B0\u5174\u4E1A\u52A1:\u5305\u62EC\u667A\u80FD\u673A\u5668\u4EBA\u548C\u6570\u5B57\u80FD\u6E90\u4E1A\u52A1;AI;\u53EF\u6301\u7EED\u53D1\u5C55",
      products: [
        "\u5DE5\u4E1A\u81EA\u52A8\u5316\u4E0E\u6570\u5B57\u5316",
        "\u5DE5\u4E1A\u673A\u5668\u4EBA\u3001\u6C7D\u8F66\u7535\u5B50\u4EA7\u54C1"
      ]
    },
    {
      code: "300136.SZ",
      name: "\u4FE1\u7EF4\u901A\u4FE1",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u8986\u76D6\u5929\u7EBF\u53CA\u6A21\u7EC4\u3001\u65E0\u7EBF\u5145\u7535\u6A21\u7EC4\u53CA\u76F8\u5173\u4EA7\u54C1\u3001EMI\\EMC\u5668\u4EF6\u3001\u9AD8\u7CBE\u5BC6\u8FDE\u63A5\u5668\u3001\u58F0\u5B66\u5668\u4EF6\u3001\u6C7D\u8F66\u4E92\u8054\u4EA7\u54C1\u3001\u88AB\u52A8\u5143\u4EF6\u7B49,\u5BA2\u6237\u6DB5\u76D6\u5168\u7403\u591A\u5BB6\u77E5\u540D\u79D1\u6280\u4F01\u4E1A,\u4E3A\u5BA2\u6237\u63D0\u4F9B\u201C\u6750\u6599\u2014\u96F6\u90E8\u4EF6\u2014\u6A21\u7EC4\u201D\u7684\u4E00\u7AD9\u5F0F\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u5C04\u9891\u96F6\u3001\u90E8\u4EF6",
        "\u5C04\u9891\u5668\u4EF6"
      ]
    },
    {
      code: "300223.SZ",
      name: "\u5317\u4EAC\u541B\u6B63",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u96C6\u6210\u7535\u8DEF\u82AF\u7247\u4EA7\u54C1\u7684\u7814\u53D1\u4E0E\u9500\u552E\u7B49\u4E1A\u52A1",
      products: [
        "\u5B58\u50A8\u82AF\u7247",
        "\u5B58\u50A8\u5668\u82AF\u7247\u3001MPU\u3001\u6A21\u62DF\u82AF\u7247\u3001\u6280\u672F\u670D\u52A1"
      ]
    },
    {
      code: "300274.SZ",
      name: "\u9633\u5149\u7535\u6E90",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u7535\u6E90\u8BBE\u5907-\u592A\u9633\u80FD",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u7535\u6E90\u8BBE\u5907",
        "\u592A\u9633\u80FD"
      ],
      mainBusiness: "\u4E13\u6CE8\u4E8E\u592A\u9633\u80FD\u3001\u98CE\u80FD\u3001\u50A8\u80FD\u3001\u6C22\u80FD\u3001\u7535\u52A8\u6C7D\u8F66\u53CA\u5145\u7535\u7B49\u65B0\u80FD\u6E90\u7535\u6E90\u8BBE\u5907\u7684\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E\u548C\u670D\u52A1",
      products: [
        "\u50A8\u80FD\u7CFB\u7EDF",
        "\u50A8\u80FD\u7CFB\u7EDF\u3001\u5149\u4F0F\u9006\u53D8\u5668\u3001\u7535\u529B\u5DE5\u7A0B\u3001\u5149\u4F0F\u53D1\u7535"
      ]
    },
    {
      code: "300285.SZ",
      name: "\u56FD\u74F7\u6750\u6599",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u65B0\u6750\u6599-\u5316\u5B66\u65B0\u6750\u6599",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u5B66\u65B0\u6750\u6599",
        "\u5316\u5B66\u65B0\u6750\u6599"
      ],
      mainBusiness: "\u5404\u7C7B\u9AD8\u7AEF\u9676\u74F7\u6750\u6599\u53CA\u5236\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u751F\u7269\u533B\u7597\u6750\u6599\u677F\u5757",
        "\u6CB9\u58A8\u3001\u50AC\u5316\u5242\u3001\u53E3\u8154\u5145\u586B\u4FEE\u590D\u6750\u6599\u3001\u7535\u5B50\u6750\u6599\u3001\u5DE5\u4E1A\u7528\u9676\u74F7\u3001\u7535\u5B50\u9676\u74F7"
      ]
    },
    {
      code: "300308.SZ",
      name: "\u4E2D\u9645\u65ED\u521B",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8BBE\u5907-\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u901A\u4FE1\u8BBE\u5907",
        "\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907"
      ],
      mainBusiness: "\u9AD8\u7AEF\u5149\u901A\u4FE1\u6536\u53D1\u6A21\u5757\u7684\u7814\u53D1\u3001\u751F\u4EA7\u53CA\u9500\u552E,\u4EA7\u54C1\u670D\u52A1\u4E8E\u4E91\u8BA1\u7B97\u6570\u636E\u4E2D\u5FC3\u3001\u6570\u636E\u901A\u4FE1\u30015G\u65E0\u7EBF\u7F51\u7EDC\u3001\u7535\u4FE1\u4F20\u8F93\u548C\u56FA\u7F51\u63A5\u5165\u7B49\u9886\u57DF\u7684\u56FD\u5185\u5916\u5BA2\u6237",
      products: [
        "\u5149\u901A\u4FE1\u6536\u53D1\u6A21\u5757",
        "\u5149\u6A21\u5757"
      ]
    },
    {
      code: "300316.SZ",
      name: "\u6676\u76DB\u673A\u7535",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u7535\u6E90\u8BBE\u5907-\u592A\u9633\u80FD",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u7535\u6E90\u8BBE\u5907",
        "\u592A\u9633\u80FD"
      ],
      mainBusiness: "\u534A\u5BFC\u4F53\u88C5\u5907\u3001\u534A\u5BFC\u4F53\u886C\u5E95\u6750\u6599\u3001\u8017\u6750\u53CA\u96F6\u90E8\u4EF6\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u8BBE\u5907\u53CA\u5176\u670D\u52A1",
        "\u5149\u4F0F\u8BBE\u5907\u3001\u84DD\u5B9D\u77F3\u6750\u6599"
      ]
    },
    {
      code: "300347.SZ",
      name: "\u6CF0\u683C\u533B\u836F",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u533B\u7597\u670D\u52A1-\u533B\u7597\u670D\u52A1",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u533B\u7597\u670D\u52A1",
        "\u533B\u7597\u670D\u52A1"
      ],
      mainBusiness: "\u4E34\u5E8A\u8BD5\u9A8C\u6280\u672F\u670D\u52A1\u548C\u4E34\u5E8A\u8BD5\u9A8C\u76F8\u5173\u670D\u52A1\u53CA\u5B9E\u9A8C\u5BA4\u670D\u52A1\u3002",
      products: [
        "\u4E34\u5E8A\u8BD5\u9A8C\u76F8\u5173\u53CA\u5B9E\u9A8C\u5BA4\u670D\u52A1",
        "\u4E34\u5E8A\u7814\u7A76\u670D\u52A1\u3001CRO"
      ]
    },
    {
      code: "300373.SZ",
      name: "\u626C\u6770\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u5206\u7ACB\u5668\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u5206\u7ACB\u5668\u4EF6"
      ],
      mainBusiness: "\u516C\u53F8\u96C6\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E\u4E8E\u4E00\u4F53,\u4E13\u4E1A\u81F4\u529B\u4E8E\u529F\u7387\u534A\u5BFC\u4F53\u7845\u7247\u3001\u82AF\u7247\u53CA\u5668\u4EF6\u8BBE\u8BA1\u3001\u5236\u9020\u3001\u5C01\u88C5\u6D4B\u8BD5\u7B49\u4E2D\u9AD8\u7AEF\u9886\u57DF\u7684\u4EA7\u4E1A\u53D1\u5C55",
      products: [
        "\u534A\u5BFC\u4F53\u529F\u7387\u5668\u4EF6",
        "\u5206\u7ACB\u5668\u4EF6\u3001\u529F\u7387IC\u3001\u7845\u7247"
      ]
    },
    {
      code: "300390.SZ",
      name: "\u5929\u534E\u65B0\u80FD",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u91D1\u5C5E\u975E\u91D1\u5C5E\u65B0\u6750\u6599-\u7535\u6C60\u6750\u6599",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u91D1\u5C5E\u975E\u91D1\u5C5E\u65B0\u6750\u6599",
        "\u7535\u6C60\u6750\u6599"
      ],
      mainBusiness: "\u65B0\u80FD\u6E90\u9502\u7535\u6750\u6599\u4E1A\u52A1,\u9632\u9759\u7535\u8D85\u51C0\u6280\u672F\u4EA7\u54C1\u4E1A\u52A1,\u533B\u7597\u5668\u68B0\u4EA7\u54C1\u4E1A\u52A1",
      products: [
        "\u9502\u7535\u6750\u6599\u4EA7\u54C1",
        "\u7535\u6C60\u7EA7\u6C22\u6C27\u5316\u9502\u3001\u7535\u6C60\u7EA7\u6C22\u6C27\u5316\u9502\u3001\u9632\u9759\u7535\u4EA7\u54C1\u3001\u9632\u9759\u7535\u4EA7\u54C1\u3001\u8F93\u6DB2\u5668"
      ]
    },
    {
      code: "300394.SZ",
      name: "\u5929\u5B5A\u901A\u4FE1",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u5149\u7535\u5B50\u5668\u4EF6-\u5149\u5B66\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u5149\u7535\u5B50\u5668\u4EF6",
        "\u5149\u5B66\u5143\u4EF6"
      ],
      mainBusiness: "\u4EE5\u7814\u53D1\u521B\u65B0\u4E3A\u9A71\u52A8,\u4F9D\u6258\u9AD8\u590D\u7528\u7684\u6280\u672F\u5E73\u53F0\u4E0E\u6DF1\u5EA6\u7684\u4EA7\u4E1A\u94FE\u5782\u76F4\u6574\u5408\u80FD\u529B,\u63D0\u4F9B\u4ECE\u65E0\u6E90\u5668\u4EF6\u3001\u6709\u6E90\u5668\u4EF6\u5230\u96C6\u6210\u5171\u7814\u7684\u4E00\u7AD9\u5F0F\u5149\u4E92\u8FDE\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u5149\u901A\u4FE1\u5143\u5668\u4EF6",
        "\u6709\u6E90\u5149\u5668\u4EF6\u3001\u65E0\u6E90\u5149\u5668\u4EF6"
      ]
    },
    {
      code: "300408.SZ",
      name: "\u4E09\u73AF\u96C6\u56E2",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u4ECE\u4E8B\u7535\u5B50\u5143\u4EF6\u53CA\u5176\u57FA\u7840\u6750\u6599\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u7535\u5B50\u5143\u4EF6\u53CA\u6750\u6599",
        "\u7535\u5B50\u5143\u4EF6\u3001\u7535\u5B50\u5C01\u88C5\u6750\u6599\u3001\u7535\u5B50\u5C01\u88C5\u6750\u6599\u3001\u7535\u5B50\u5C01\u88C5\u6750\u6599"
      ]
    },
    {
      code: "300438.SZ",
      name: "\u9E4F\u8F89\u80FD\u6E90",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u7535\u6E90\u8BBE\u5907-\u50A8\u80FD\u8BBE\u5907",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u7535\u6E90\u8BBE\u5907",
        "\u50A8\u80FD\u8BBE\u5907"
      ],
      mainBusiness: "\u9502\u79BB\u5B50\u7535\u6C60\u3001\u4E00\u6B21\u7535\u6C60(\u9502\u94C1\u7535\u6C60\u3001\u9502\u9530\u7535\u6C60\u7B49)\u3001\u954D\u6C22\u7535\u6C60\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u4E8C\u6B21\u9502\u7535\u6C60",
        "\u9502\u79BB\u5B50\u7535\u6C60\u3001\u9502\u539F\u7535\u6C60"
      ]
    },
    {
      code: "300475.SZ",
      name: "\u9999\u519C\u82AF\u521B",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u7535\u5B50\u5143\u5668\u4EF6\u5206\u9500\u4E1A\u52A1",
      products: [
        "\u7535\u5B50\u5206\u9500\u670D\u52A1\u3001\u7535\u5B50\u5143\u5668\u4EF6\u5206\u9500\u670D\u52A1\u3001DRAM\u82AF\u7247\u3001\u6D17\u8863\u673A\u51CF\u901F\u5668\u3001\u51CF\u901F\u673A"
      ]
    },
    {
      code: "300476.SZ",
      name: "\u80DC\u5B8F\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u9AD8\u5BC6\u5EA6\u5370\u5236\u7EBF\u8DEF\u677F\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u5176\u4ED6\u4E1A\u52A1",
        "\u5370\u5236\u7535\u8DEF\u677F"
      ]
    },
    {
      code: "300498.SZ",
      name: "\u6E29\u6C0F\u80A1\u4EFD",
      availability: "available",
      industry: "\u519C\u6797\u7267\u6E14-\u755C\u7267\u4E1A-\u517B\u6B96",
      industryLevels: [
        "\u519C\u6797\u7267\u6E14",
        "\u755C\u7267\u4E1A",
        "\u517B\u6B96"
      ],
      mainBusiness: "\u8089\u9E21\u548C\u8089\u732A\u7684\u517B\u6B96\u53CA\u5176\u9500\u552E;\u517C\u8425\u8089\u9E2D\u3001\u86CB\u9E21\u3001\u9E3D\u5B50\u7B49\u7684\u517B\u6B96\u53CA\u5176\u4EA7\u54C1\u7684\u9500\u552E\u3002\u540C\u65F6,\u516C\u53F8\u56F4\u7ED5\u755C\u79BD\u517B\u6B96\u4EA7\u4E1A\u94FE\u4E0A\u4E0B\u6E38,\u914D\u5957\u7ECF\u8425\u755C\u79BD\u5C60\u5BB0\u3001\u98DF\u54C1\u52A0\u5DE5\u3001\u73B0\u4EE3\u519C\u7267\u8BBE\u5907\u5236\u9020\u3001\u517D\u836F\u751F\u4EA7\u4EE5\u53CA\u91D1\u878D\u6295\u8D44\u7B49\u4E1A\u52A1",
      products: [
        "\u8089\u732A\u7C7B\u517B\u6B96",
        "\u751F\u732A\u3001\u8089\u9E21\u3001\u5176\u4ED6\u7272\u755C\u3001\u517D\u836F\u3001\u519C\u7528\u673A\u68B0\u96F6\u90E8\u4EF6\u3001\u8089\u5236\u54C1"
      ]
    },
    {
      code: "300502.SZ",
      name: "\u65B0\u6613\u76DB",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8BBE\u5907-\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u901A\u4FE1\u8BBE\u5907",
        "\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907"
      ],
      mainBusiness: "\u5168\u7CFB\u5217\u5149\u901A\u4FE1\u5E94\u7528\u7684\u5149\u6A21\u5757\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u5149\u4E92\u8054\u4EA7\u54C1",
        "\u5149\u6A21\u5757"
      ]
    },
    {
      code: "300548.SZ",
      name: "\u957F\u82AF\u535A\u521B",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8BBE\u5907-\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u901A\u4FE1\u8BBE\u5907",
        "\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907"
      ],
      mainBusiness: "\u5149\u901A\u4FE1\u9886\u57DF\u96C6\u6210\u5149\u7535\u5B50\u5668\u4EF6\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u6570\u636E\u901A\u4FE1\u3001\u6D88\u8D39\u53CA\u5DE5\u4E1A\u4E92\u8054\u5E02\u573A",
        "\u5149\u901A\u4FE1\u5668\u4EF6\u3001\u5149\u901A\u4FE1\u5668\u4EF6"
      ]
    },
    {
      code: "300567.SZ",
      name: "\u7CBE\u6D4B\u7535\u5B50",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u901A\u7528\u8BBE\u5907-\u4EEA\u5668\u4EEA\u8868",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u901A\u7528\u8BBE\u5907",
        "\u4EEA\u5668\u4EEA\u8868"
      ],
      mainBusiness: "\u4ECE\u4E8B\u663E\u793A\u3001\u534A\u5BFC\u4F53\u3001\u65B0\u80FD\u6E90\u68C0\u6D4B\u7CFB\u7EDF\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u663E\u793A",
        "\u6DB2\u6676\u663E\u793A\u5668\u4EF6\u68C0\u6D4B\u8BBE\u5907\u3001\u534A\u5BFC\u4F53\u6D4B\u8BD5\u8BBE\u5907\u3001\u7535\u6C60\u68C0\u6D4B\u8BBE\u5907"
      ]
    },
    {
      code: "300570.SZ",
      name: "\u592A\u8FB0\u5149",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8BBE\u5907-\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u901A\u4FE1\u8BBE\u5907",
        "\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907"
      ],
      mainBusiness: "\u4E13\u6CE8\u4E8E\u5149\u901A\u4FE1\u9886\u57DF,\u662F\u4E00\u5BB6\u5168\u9762\u6DB5\u76D6\u7814\u53D1\u3001\u5236\u9020\u3001\u9500\u552E\u548C\u670D\u52A1\u7684\u9AD8\u65B0\u6280\u672F\u4F01\u4E1A,\u4EA7\u54C1\u5305\u62EC\u5404\u79CD\u5149\u901A\u4FE1\u5668\u4EF6\u53CA\u5176\u96C6\u6210\u529F\u80FD\u6A21\u5757(\u4EE5\u4E0B\u7B80\u79F0\u201C\u5149\u5668\u4EF6\u4EA7\u54C1\u201D)\u548C\u5149\u4F20\u611F\u4EA7\u54C1\u53CA\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u5149\u5668\u4EF6\u4EA7\u54C1",
        "\u5149\u901A\u4FE1\u5668\u4EF6\u3001\u4F20\u611F\u5668"
      ]
    },
    {
      code: "300604.SZ",
      name: "\u957F\u5DDD\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u96C6\u6210\u7535\u8DEF\u4E13\u7528\u8BBE\u5907\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u6D4B\u8BD5\u673A",
        "\u534A\u5BFC\u4F53\u6D4B\u8BD5\u8BBE\u5907\u3001\u534A\u5BFC\u4F53\u6D4B\u8BD5\u8BBE\u5907"
      ]
    },
    {
      code: "300661.SZ",
      name: "\u5723\u90A6\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u6A21\u62DF\u96C6\u6210\u7535\u8DEF\u7684\u7814\u53D1\u4E0E\u9500\u552E",
      products: [
        "\u7535\u6E90\u7BA1\u7406\u4EA7\u54C1",
        "\u7535\u6E90\u7BA1\u7406\u82AF\u7247\u3001\u4FE1\u53F7\u94FE\u82AF\u7247"
      ]
    },
    {
      code: "300666.SZ",
      name: "\u6C5F\u4E30\u7535\u5B50",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u6750\u6599"
      ],
      mainBusiness: "\u8D85\u9AD8\u7EAF\u91D1\u5C5E\u6E85\u5C04\u9776\u6750\u3001\u534A\u5BFC\u4F53\u7CBE\u5BC6\u96F6\u90E8\u4EF6\u3001\u7B2C\u4E09\u4EE3\u534A\u5BFC\u4F53\u5173\u952E\u6750\u6599\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E,\u5176\u4E2D\u8D85\u9AD8\u7EAF\u91D1\u5C5E\u6E85\u5C04\u9776\u6750\u5305\u62EC\u94DD\u9776\u3001\u949B\u9776\u3001\u94BD\u9776\u3001\u94DC\u9776\u4EE5\u53CA\u5404\u79CD\u8D85\u9AD8\u7EAF\u91D1\u5C5E\u5408\u91D1\u9776\u6750\u7B49",
      products: [
        "\u8D85\u9AD8\u7EAF\u9776\u6750",
        "\u9776\u6750\u3001\u5206\u7ACB\u5668\u4EF6"
      ]
    },
    {
      code: "300677.SZ",
      name: "\u82F1\u79D1\u533B\u7597",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u533B\u7597\u5668\u68B0-\u533B\u7597\u5668\u68B0",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u533B\u7597\u5668\u68B0",
        "\u533B\u7597\u5668\u68B0"
      ],
      mainBusiness: "\u4E3B\u8425\u4E1A\u52A1\u6DB5\u76D6\u4E2A\u4EBA\u9632\u62A4\u3001\u5EB7\u590D\u62A4\u7406\u3001\u5176\u4ED6\u4EA7\u54C1\u4E09\u5927\u677F\u5757",
      products: [
        "\u533B\u7597\u9632\u62A4\u7C7B",
        "\u5851\u6599\u624B\u5957\u3001\u533B\u7528\u5EB7\u590D\u5668\u68B0"
      ]
    },
    {
      code: "300750.SZ",
      name: "\u5B81\u5FB7\u65F6\u4EE3",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u7535\u6E90\u8BBE\u5907-\u50A8\u80FD\u8BBE\u5907",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u7535\u6E90\u8BBE\u5907",
        "\u50A8\u80FD\u8BBE\u5907"
      ],
      mainBusiness: "\u4ECE\u4E8B\u52A8\u529B\u7535\u6C60\u3001\u50A8\u80FD\u7535\u6C60\u7684\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E,\u4EE5\u63A8\u52A8\u56FA\u5B9A\u5F0F\u5316\u77F3\u80FD\u6E90\u66FF\u4EE3\u3001\u79FB\u52A8\u5F0F\u5316\u77F3\u80FD\u6E90\u66FF\u4EE3,\u5E76\u901A\u8FC7\u7535\u52A8\u5316\u548C\u667A\u80FD\u5316\u5B9E\u73B0\u5E02\u573A\u5E94\u7528\u7684\u96C6\u6210\u521B\u65B0",
      products: [
        "\u52A8\u529B\u7535\u6C60\u7CFB\u7EDF",
        "\u52A8\u529B\u7535\u6C60\u7CFB\u7EDF\u3001\u50A8\u80FD\u7535\u6C60\u7CFB\u7EDF\u3001\u5E9F\u65E7\u7535\u6C60\u56DE\u6536\u5229\u7528"
      ]
    },
    {
      code: "300751.SZ",
      name: "\u8FC8\u4E3A\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u7535\u6E90\u8BBE\u5907-\u592A\u9633\u80FD",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u7535\u6E90\u8BBE\u5907",
        "\u592A\u9633\u80FD"
      ],
      mainBusiness: "\u667A\u80FD\u5236\u9020\u88C5\u5907\u7684\u8BBE\u8BA1\u3001\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u6210\u5957\u8BBE\u5907",
        "\u5149\u4F0F\u7535\u6C60\u7247\u52A0\u5DE5\u8BBE\u5907\u3001\u5149\u4F0F\u7535\u6C60\u7247\u52A0\u5DE5\u8BBE\u5907\u3001\u5149\u4F0F\u52A0\u5DE5\u8BBE\u5907\u914D\u4EF6"
      ]
    },
    {
      code: "300757.SZ",
      name: "\u7F57\u535A\u7279\u79D1",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u4E13\u7528\u8BBE\u5907-\u5176\u4ED6\u4E13\u7528\u673A\u68B0",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u4E13\u7528\u8BBE\u5907",
        "\u5176\u4ED6\u4E13\u7528\u673A\u68B0"
      ],
      mainBusiness: "\u5DE5\u4E1A\u81EA\u52A8\u5316\u8BBE\u5907,\u5DE5\u4E1A\u6267\u884C\u7CFB\u7EDF\u8F6F\u4EF6,\u9AD8\u6548\u7535\u6C60\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u5149\u7535\u5B50\u53CA\u534A\u5BFC\u4F53\u5C01\u6D4B\u8BBE\u5907",
        "\u534A\u5BFC\u4F53\u5C01\u6D4B\u8BBE\u5907\u3001\u5149\u4F0F\u8BBE\u5907"
      ]
    },
    {
      code: "300759.SZ",
      name: "\u5EB7\u9F99\u5316\u6210",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u751F\u7269\u533B\u836F-\u751F\u7269\u533B\u836F",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u751F\u7269\u533B\u836F",
        "\u751F\u7269\u533B\u836F"
      ],
      mainBusiness: "\u5B9E\u9A8C\u5BA4\u670D\u52A1\u3001CMC(\u5C0F\u5206\u5B50CDMO)\u670D\u52A1\u3001\u4E34\u5E8A\u7814\u7A76\u670D\u52A1\u3001\u5927\u5206\u5B50\u548C\u7EC6\u80DE\u4E0E\u57FA\u56E0\u6CBB\u7597\u670D\u52A1",
      products: [
        "\u836F\u7269\u53D1\u73B0\u4E0E\u7814\u7A76",
        "\u836F\u7269\u53D1\u73B0\u670D\u52A1\u3001\u533B\u836FCDMO\u3001\u4E34\u5E8A\u7814\u7A76\u670D\u52A1\u3001\u514D\u75AB\u6CBB\u7597"
      ]
    },
    {
      code: "300760.SZ",
      name: "\u8FC8\u745E\u533B\u7597",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u533B\u7597\u5668\u68B0-\u533B\u7597\u5668\u68B0",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u533B\u7597\u5668\u68B0",
        "\u533B\u7597\u5668\u68B0"
      ],
      mainBusiness: "\u533B\u7597\u5668\u68B0\u7684\u7814\u53D1\u3001\u5236\u9020\u3001\u8425\u9500\u53CA\u670D\u52A1,\u59CB\u7EC8\u4EE5\u5BA2\u6237\u9700\u6C42\u4E3A\u5BFC\u5411,\u81F4\u529B\u4E8E\u4E3A\u5168\u7403\u533B\u7597\u673A\u6784\u63D0\u4F9B\u4F18\u8D28\u7684\u4EA7\u54C1\u3001\u670D\u52A1\u548C\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u4F53\u5916\u8BCA\u65AD\u7C7B\u4EA7\u54C1",
        "\u4F53\u5916\u8BCA\u65AD\u8BBE\u5907\u3001\u533B\u7528\u8BCA\u5BDF\u53CA\u76D1\u62A4\u5668\u68B0\u3001\u533B\u7528\u6210\u50CF\u5668\u68B0\u3001\u533B\u7597\u4FDD\u5065\u8BBE\u5907"
      ]
    },
    {
      code: "300776.SZ",
      name: "\u5E1D\u5C14\u6FC0\u5149",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u6FC0\u5149\u7CBE\u5BC6\u5FAE\u7EB3\u52A0\u5DE5\u89E3\u51B3\u65B9\u6848\u7684\u8BBE\u8BA1\u53CA\u5176\u914D\u5957\u8BBE\u5907\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u592A\u9633\u80FD\u7535\u6C60\u6FC0\u5149\u52A0\u5DE5\u8BBE\u5907",
        "\u5149\u4F0F\u7535\u6C60\u7247\u52A0\u5DE5\u8BBE\u5907\u3001\u5149\u4F0F\u52A0\u5DE5\u8BBE\u5907\u3001\u5149\u4F0F\u7535\u6C60\u7247\u52A0\u5DE5\u8BBE\u5907"
      ]
    },
    {
      code: "300857.SZ",
      name: "\u534F\u521B\u6570\u636E",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u6D88\u8D39\u7535\u5B50\u8BBE\u5907-\u6D88\u8D39\u7535\u5B50\u8BBE\u5907",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u6D88\u8D39\u7535\u5B50\u8BBE\u5907",
        "\u6D88\u8D39\u7535\u5B50\u8BBE\u5907"
      ],
      mainBusiness: "\u6280\u672F\u521B\u65B0\u4E3A\u6838\u5FC3\u7684\u7ECF\u8425\u6A21\u5F0F,\u901A\u8FC7\u7814\u53D1\u5148\u8FDB\u7684\u786C\u4EF6\u548C\u8F6F\u4EF6\u89E3\u51B3\u65B9\u6848,\u63D0\u4F9B\u4E00\u4F53\u5316\u7684\u4EA7\u54C1\u548C\u670D\u52A1",
      products: [
        "\u667A\u80FD\u7B97\u529B\u4EA7\u54C1\u53CA\u670D\u52A1",
        "\u5B58\u50A8\u8BBE\u5907\u3001\u4E91\u8BA1\u7B97\u670D\u52A1\u3001\u670D\u52A1\u5668\u3001\u89C6\u9891\u76D1\u63A7\u8BBE\u5907"
      ]
    },
    {
      code: "300972.SZ",
      name: "\u4E07\u8FB0\u96C6\u56E2",
      availability: "available",
      industry: "\u5546\u8D38\u96F6\u552E-\u96F6\u552E-\u8FDE\u9501",
      industryLevels: [
        "\u5546\u8D38\u96F6\u552E",
        "\u96F6\u552E",
        "\u8FDE\u9501"
      ],
      mainBusiness: "\u91CF\u8D29\u96F6\u98DF\u4E1A\u52A1\u548C\u98DF\u7528\u83CC\u4E1A\u52A1,\u5176\u4E2D\u91CF\u8D29\u96F6\u98DF\u4E1A\u52A1\u662F\u4F11\u95F2\u98DF\u54C1\u4E3A\u4E3B\u7684\u91C7\u8D2D\u3001\u9500\u552E\u3001\u4ED3\u50A8\u7269\u6D41\u73AF\u8282,\u4E0D\u6D89\u53CA\u751F\u4EA7\u73AF\u8282,\u98DF\u7528\u83CC\u4E1A\u52A1\u5305\u62EC\u9C9C\u54C1\u98DF\u7528\u83CC\u7684\u7814\u53D1\u3001\u5DE5\u5382\u5316\u57F9\u80B2\u4E0E\u9500\u552E",
      products: [
        "\u96F6\u98DF",
        "\u96F6\u98DF\u3001\u98DF\u7528\u83CC\u3001\u98DF\u7528\u83CC\u3001\u98DF\u7528\u83CC\u3001\u519C\u4E1A\u5E9F\u6599"
      ]
    },
    {
      code: "301308.SZ",
      name: "\u6C5F\u6CE2\u9F99",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u5B58\u50A8\u5668\u548C\u4E3B\u63A7\u82AF\u7247\u7684\u7814\u53D1\u8BBE\u8BA1\u3001\u5C01\u88C5\u6D4B\u8BD5\u3001\u6280\u672F\u652F\u6301\u4E0E\u5B58\u50A8\u5668\u9500\u552E\u3002\u516C\u53F8\u901A\u8FC7\u8986\u76D6\u82AF\u7247\u8BBE\u8BA1(\u4E3B\u63A7\u82AF\u7247\u53CA\u5B58\u50A8\u82AF\u7247)\u3001\u56FA\u4EF6\u7B97\u6CD5\u5F00\u53D1\u3001\u5B58\u50A8\u5668\u8BBE\u8BA1\u3001\u5C01\u88C5\u6D4B\u8BD5\u7B49\u5B58\u50A8\u5173\u952E\u73AF\u8282\u7684\u5168\u6808\u5F0F\u6280\u672F\u80FD\u529B,\u4E3A\u5E02\u573A\u63D0\u4F9B\u6D88\u8D39\u7EA7\u3001\u4F01\u4E1A\u7EA7\u3001\u8F66\u89C4\u7EA7\u3001\u5DE5\u89C4\u7EA7\u5B58\u50A8\u5668\u4EE5\u53CA\u884C\u4E1A\u5B58\u50A8\u8F6F\u786C\u4EF6\u5E94\u7528\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u5B58\u50A8\u4EA7\u54C1",
        "\u5B58\u50A8\u8BBE\u5907\u3001\u5B58\u50A8\u8BBE\u5907\u3001\u5B58\u50A8\u8BBE\u5907\u3001\u5B58\u50A8\u8BBE\u5907"
      ]
    },
    {
      code: "301377.SZ",
      name: "\u9F0E\u6CF0\u9AD8\u79D1",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u91D1\u5C5E\u5236\u54C1-\u91D1\u5C5E\u5236\u54C1",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u91D1\u5C5E\u5236\u54C1",
        "\u91D1\u5C5E\u5236\u54C1"
      ],
      mainBusiness: "\u4E13\u4E1A\u4E3APCB\u3001\u6570\u63A7\u7CBE\u5BC6\u673A\u4EF6\u7B49\u9886\u57DF\u7684\u4F01\u4E1A\u63D0\u4F9B\u5DE5\u5177\u3001\u6750\u6599\u3001\u88C5\u5907\u7684\u4E00\u4F53\u5316\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u5200\u5177\u4EA7\u54C1",
        "\u94E3\u5200\u3001\u78E8\u5177\u3001\u6570\u63A7\u673A\u5E8A\u3001\u8986\u819C\u6750\u6599"
      ]
    },
    {
      code: "301396.SZ",
      name: "\u5B8F\u666F\u79D1\u6280",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u8F6F\u4EF6-\u5176\u4ED6\u8F6F\u4EF6\u670D\u52A1",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u8BA1\u7B97\u673A\u8F6F\u4EF6",
        "\u5176\u4ED6\u8F6F\u4EF6\u670D\u52A1"
      ],
      mainBusiness: "\u4E00\u5BB6\u5177\u5907\u81EA\u4E3B\u7814\u53D1\u80FD\u529B\u7684\u65B0\u578B\u6570\u5B57\u57FA\u7840\u8BBE\u65BD\u4E0E\u667A\u80FD\u7B97\u529B\u7EFC\u5408\u670D\u52A1\u5546,\u4E13\u6CE8\u4E8E\u4EBA\u5DE5\u667A\u80FD\u3001\u5927\u6570\u636E\u3001\u9AD8\u6027\u80FD\u8BA1\u7B97\u7B49\u524D\u6CBF\u6280\u672F\u7684\u7814\u53D1\u521B\u65B0\u4E0E\u4EA7\u4E1A\u5316\u5E94\u7528",
      products: [
        "\u7B97\u529B\u8BBE\u5907\u96C6\u6210\u670D\u52A1",
        "\u8BBE\u5907\u7C7B\u7CFB\u7EDF\u96C6\u6210\u670D\u52A1\u3001\u667A\u6167\u57CE\u5E02"
      ]
    },
    {
      code: "301511.SZ",
      name: "\u5FB7\u798F\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u5404\u7C7B\u9AD8\u6027\u80FD\u7535\u89E3\u94DC\u7B94\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u9502\u7535\u94DC\u7B94",
        "\u9502\u7535\u94DC\u7B94\u3001\u6807\u51C6\u94DC\u7B94"
      ]
    },
    {
      code: "301526.SZ",
      name: "\u56FD\u9645\u590D\u6750",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102-\u73BB\u7EA4",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102",
        "\u73BB\u7EA4"
      ],
      mainBusiness: "\u73BB\u7483\u7EA4\u7EF4\u53CA\u5176\u5236\u54C1\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E",
      products: [
        "\u73BB\u7483\u7EA4\u7EF4\u53CA\u5236\u54C1",
        "\u73BB\u7483\u7EA4\u7EF4\u5236\u54C1"
      ]
    },
    {
      code: "301536.SZ",
      name: "\u661F\u5BB8\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u4E13\u6CE8\u4E8E\u7AEF\u4FA7\u548C\u8FB9\u7F18\u4FA7AISoC\u82AF\u7247\u7684\u7814\u53D1\u53CA\u9500\u552E",
      products: [
        "\u667A\u80FD\u5B89\u9632",
        "\u4F20\u611F\u5668\u82AF\u7247\u3001\u4F20\u611F\u5668\u82AF\u7247\u3001\u4F20\u611F\u5668\u82AF\u7247\u3001\u4F20\u611F\u5668\u82AF\u7247\u3001\u84DD\u7259\u82AF\u7247\u3001\u79DF\u8D41\u670D\u52A1\u3001\u4F20\u611F\u5668\u82AF\u7247"
      ]
    },
    {
      code: "301666.SZ",
      name: "\u5927\u666E\u5FAE",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u786C\u4EF6-\u4E13\u7528\u8BA1\u7B97\u673A\u8BBE\u5907",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u8BA1\u7B97\u673A\u786C\u4EF6",
        "\u4E13\u7528\u8BA1\u7B97\u673A\u8BBE\u5907"
      ],
      mainBusiness: "\u6570\u636E\u4E2D\u5FC3\u4F01\u4E1A\u7EA7SSD\u4EA7\u54C1\u7684\u7814\u53D1\u548C\u9500\u552E",
      products: [
        "\u4F01\u4E1A\u7EA7SSD\u4EA7\u54C1\u9500\u552E",
        "Flash\u82AF\u7247\u3001Flash\u82AF\u7247\u3001\u6280\u672F\u670D\u52A1\u3001ASIC"
      ]
    },
    {
      code: "301669.SZ",
      name: "\u9AD8\u7279\u7535\u5B50",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u5176\u4ED6\u7535\u6C14\u8BBE\u5907-\u5176\u4ED6\u7535\u6C14\u8BBE\u5907",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u5176\u4ED6\u7535\u6C14\u8BBE\u5907",
        "\u5176\u4ED6\u7535\u6C14\u8BBE\u5907"
      ],
      mainBusiness: "\u516C\u53F8\u4E3B\u8981\u9762\u5411\u65B0\u80FD\u6E90\u4EA7\u4E1A\u63D0\u4F9B\u5B89\u5168\u3001\u53EF\u9760\u3001\u9AD8\u6548\u3001\u7A33\u5B9A\u4E14\u66F4\u5177\u7ECF\u6D4E\u6027\u7684\u65B0\u578B\u50A8\u80FD\u7535\u6C60\u7BA1\u7406\u7CFB\u7EDF\u76F8\u5173\u4EA7\u54C1",
      products: [
        "\u50A8\u80FDBMS\u76F8\u5173\u4EA7\u54C1",
        "\u7535\u6C60\u7BA1\u7406\u7CFB\u7EDF"
      ]
    },
    {
      code: "301682.SZ",
      name: "\u5B8F\u660E\u7535\u5B50",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u4EE5\u963B\u5BB9\u5143\u5668\u4EF6\u4E3A\u4E3B\u7684\u65B0\u578B\u7535\u5B50\u5143\u5668\u4EF6\u53CA\u7CBE\u5BC6\u96F6\u7EC4\u4EF6\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u7535\u5B50\u5143\u5668\u4EF6",
        "\u7535\u5B50\u5143\u4EF6\u3001\u7535\u5B50\u5143\u4EF6\u3001\u7535\u5B50\u7CBE\u5BC6\u7ED3\u6784\u4EF6"
      ]
    },
    {
      code: "600028.SH",
      name: "\u4E2D\u56FD\u77F3\u5316",
      availability: "available",
      industry: "\u5316\u77F3\u80FD\u6E90-\u77F3\u6CB9\u5929\u7136\u6C14-\u77F3\u6CB9\u52A0\u5DE5",
      industryLevels: [
        "\u5316\u77F3\u80FD\u6E90",
        "\u77F3\u6CB9\u5929\u7136\u6C14",
        "\u77F3\u6CB9\u52A0\u5DE5"
      ],
      mainBusiness: "\u77F3\u6CB9\u4E0E\u5929\u7136\u6C14\u52D8\u63A2\u5F00\u91C7\u3001\u7BA1\u9053\u8FD0\u8F93\u3001\u9500\u552E;\u77F3\u6CB9\u70BC\u5236\u3001\u77F3\u6CB9\u5316\u5DE5\u3001\u7164\u5316\u5DE5\u3001\u5316\u7EA4\u53CA\u5176\u4ED6\u5316\u5DE5\u4EA7\u54C1\u7684\u751F\u4EA7\u4E0E\u9500\u552E\u3001\u50A8\u8FD0;\u77F3\u6CB9\u3001\u5929\u7136\u6C14\u3001\u77F3\u6CB9\u4EA7\u54C1\u3001\u77F3\u6CB9\u5316\u5DE5\u53CA\u5176\u4ED6\u5316\u5DE5\u4EA7\u54C1\u548C\u5176\u4ED6\u5546\u54C1\u3001\u6280\u672F\u7684\u8FDB\u51FA\u53E3\u3001\u4EE3\u7406\u8FDB\u51FA\u53E3\u4E1A\u52A1;\u6280\u672F\u3001\u4FE1\u606F\u7684\u7814\u7A76\u3001\u5F00\u53D1\u3001\u5E94\u7528;\u6C22\u6C14\u7684\u5236\u5907\u3001\u50A8\u5B58\u3001\u8FD0\u8F93\u548C\u9500\u552E\u7B49\u6C22\u80FD\u4E1A\u52A1\u53CA\u76F8\u5173\u670D\u52A1;\u65B0\u80FD\u6E90\u6C7D\u8F66\u5145\u6362\u7535,\u592A\u9633\u80FD\u3001\u98CE\u80FD\u7B49\u65B0\u80FD\u6E90\u53D1\u7535\u4E1A\u52A1\u53CA\u76F8\u5173\u670D\u52A1",
      products: [
        "\u6C7D\u6CB9\u3001\u67F4\u6CB9\u3001\u539F\u6CB9\u3001\u5176\u4ED6\u5316\u5DE5\u4EA7\u54C1\u3001\u7164\u6CB9\u3001\u6709\u673A\u5316\u5DE5\u3001\u5408\u6210\u6811\u8102\u3001\u5929\u7136\u6C14\u3001\u70C3\u7C7B\u3001\u77F3\u5316\u4EA7\u54C1"
      ]
    },
    {
      code: "600030.SH",
      name: "\u4E2D\u4FE1\u8BC1\u5238",
      availability: "available",
      industry: "\u91D1\u878D-\u975E\u94F6\u884C\u91D1\u878D-\u8BC1\u5238",
      industryLevels: [
        "\u91D1\u878D",
        "\u975E\u94F6\u884C\u91D1\u878D",
        "\u8BC1\u5238"
      ],
      mainBusiness: "\u6295\u8D44\u94F6\u884C\u4E1A\u52A1,\u8D22\u5BCC\u7BA1\u7406\u4E1A\u52A1,\u673A\u6784\u80A1\u7968\u7ECF\u7EAA\u4E1A\u52A1,\u91D1\u878D\u5E02\u573A\u4E1A\u52A1,\u8D44\u4EA7\u7BA1\u7406\u4E1A\u52A1,\u6295\u8D44\u4E1A\u52A1,\u6258\u7BA1\u53CA\u7814\u7A76\u7B49\u670D\u52A1",
      products: [
        "\u8BC1\u5238\u6295\u8D44\u4E1A\u52A1",
        "\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238"
      ]
    },
    {
      code: "600031.SH",
      name: "\u4E09\u4E00\u91CD\u5DE5",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u4E13\u7528\u8BBE\u5907-\u5DE5\u7A0B\u673A\u68B0",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u4E13\u7528\u8BBE\u5907",
        "\u5DE5\u7A0B\u673A\u68B0"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u5DE5\u7A0B\u673A\u68B0\u7684\u7814\u53D1\u3001\u5236\u9020\u3001\u9500\u552E\u548C\u670D\u52A1",
      products: [
        "\u6316\u6398\u673A\u68B0",
        "\u6316\u6398\u673A\u68B0\u3001\u6DF7\u51DD\u571F\u673A\u68B0\u3001\u8D77\u91CD\u673A\u68B0\u3001\u7B51\u517B\u8DEF\u673A\u68B0\u3001\u6869\u5DE5\u673A\u68B0"
      ]
    },
    {
      code: "600036.SH",
      name: "\u62DB\u5546\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C"
      ],
      mainBusiness: "\u4E3B\u8981\u4E1A\u52A1\u5206\u90E8\u5305\u62EC\u96F6\u552E\u91D1\u878D\u4E1A\u52A1\u548C\u6279\u53D1\u91D1\u878D\u4E1A\u52A1\u3002\u96F6\u552E\u91D1\u878D\u4E1A\u52A1\u4E3B\u8981\u6709\u8D22\u5BCC\u7BA1\u7406\u4E1A\u52A1,\u79C1\u4EBA\u94F6\u884C\u4E1A\u52A1,\u4FE1\u7528\u5361\u4E1A\u52A1,\u96F6\u552E\u8D37\u6B3E\u3002\u6279\u53D1\u91D1\u878D\u4E1A\u52A1\u4E3B\u8981\u6709\u6279\u53D1\u5BA2\u6237,\u516C\u53F8\u5BA2\u6237\u5B58\u6B3E,\u516C\u53F8\u8D37\u6B3E,\u79D1\u6280\u91D1\u878D\u4E1A\u52A1,\u666E\u60E0\u91D1\u878D\u4E1A\u52A1,\u517B\u8001\u91D1\u878D\u4E1A\u52A1,\u7968\u636E\u4E1A\u52A1,\u4EA4\u6613\u94F6\u884C\u4E1A\u52A1,\u8DE8\u5883\u91D1\u878D\u4E1A\u52A1,\u6295\u8D44\u94F6\u884C\u4E1A\u52A1,\u540C\u4E1A\u4E1A\u52A1,\u8D44\u4EA7\u7BA1\u7406\u4E1A\u52A1,\u8D44\u4EA7\u6258\u7BA1\u4E1A\u52A1,\u91D1\u878D\u5E02\u573A\u4E1A\u52A1\u3002",
      products: [
        "\u96F6\u552E\u91D1\u878D\u4E1A\u52A1",
        "\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u516C\u53F8\u4E1A\u52A1\u3001\u7EFC\u5408\u6027\u94F6\u884C\u4E2A\u4EBA\u4E1A\u52A1\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C"
      ]
    },
    {
      code: "600060.SH",
      name: "\u6D77\u4FE1\u89C6\u50CF",
      availability: "available",
      industry: "\u5BB6\u7535-\u89C6\u542C\u5668\u6750-\u89C6\u542C\u5668\u6750",
      industryLevels: [
        "\u5BB6\u7535",
        "\u89C6\u542C\u5668\u6750",
        "\u89C6\u542C\u5668\u6750"
      ],
      mainBusiness: "\u663E\u793A\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E,\u4EE5\u53CA\u4E91\u5E73\u53F0\u670D\u52A1\u3002",
      products: [
        "\u667A\u6167\u663E\u793A\u7EC8\u7AEF",
        "\u5F69\u8272\u7535\u89C6\u673A\u3001\u663E\u793A\u5668\u4EF6"
      ]
    },
    {
      code: "600066.SH",
      name: "\u5B87\u901A\u5BA2\u8F66",
      availability: "available",
      industry: "\u4EA4\u8FD0\u8BBE\u5907-\u6C7D\u8F66-\u5546\u7528\u8F66",
      industryLevels: [
        "\u4EA4\u8FD0\u8BBE\u5907",
        "\u6C7D\u8F66",
        "\u5546\u7528\u8F66"
      ],
      mainBusiness: "\u5BA2\u8F66\u7684\u751F\u4EA7\u548C\u9500\u552E,\u63D0\u4F9B\u6C7D\u8F66\u7EF4\u4FEE\u52B3\u52A1\u4EE5\u53CA\u5E02\u53BF\u9645\u5B9A\u7EBF\u65C5\u6E38\u5BA2\u8FD0\u670D\u52A1\u3002",
      products: [
        "\u5BA2\u8F66"
      ]
    },
    {
      code: "600089.SH",
      name: "\u7279\u53D8\u7535\u5DE5",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u8F93\u53D8\u7535\u8BBE\u5907-\u5176\u4ED6\u8F93\u53D8\u7535\u8BBE\u5907",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u8F93\u53D8\u7535\u8BBE\u5907",
        "\u5176\u4ED6\u8F93\u53D8\u7535\u8BBE\u5907"
      ],
      mainBusiness: "\u5305\u62EC\u8F93\u53D8\u7535\u4E1A\u52A1\u3001\u65B0\u80FD\u6E90\u4E1A\u52A1\u3001\u80FD\u6E90\u4E1A\u52A1\u53CA\u65B0\u6750\u6599\u4E1A\u52A1",
      products: [
        "\u53D8\u538B\u5668",
        "\u53D8\u538B\u5668\u3001\u539F\u7164\u3001\u7535\u7EBF\u7535\u7F06\u3001\u5149\u4F0F\u4EA7\u54C1\u3001\u53EF\u518D\u751F\u80FD\u6E90\u53D1\u7535\u3001\u94DD\u52A0\u5DE5\u4EA7\u54C1\u3001\u7535\u529B\u5DE5\u7A0B\u3001\u9EC4\u91D1\u3001\u7269\u6D41"
      ]
    },
    {
      code: "600105.SH",
      name: "\u6C38\u9F0E\u80A1\u4EFD",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8BBE\u5907-\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u901A\u4FE1\u8BBE\u5907",
        "\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907"
      ],
      mainBusiness: "\u7ACB\u8DB3\u201C\u5149\u68D2\u3001\u5149\u7EA4\u3001\u5149\u7F06\u201D\u7B49\u7F51\u7EDC\u57FA\u7840\u901A\u4FE1\u4EA7\u54C1,\u5EF6\u4F38\u5149\u82AF\u7247\u3001\u5149\u5668\u4EF6\u3001\u5149\u6A21\u5757\u7B49\u4EA7\u54C1\u53CA\u5927\u6570\u636E\u91C7\u96C6\u5206\u6790\u5E94\u7528\u4E0E\u4FE1\u606F\u670D\u52A1,\u7535\u529B\u4F20\u8F93\u4EA7\u4E1A\u5305\u542B\u7535\u529B\u5DE5\u7A0B\u603B\u627F\u5305\u3001\u6C7D\u8F66\u7EBF\u675F\u3001\u8D85\u5BFC\u3001\u7535\u7F06\u3001\u7279\u7F06\u7B49\u3002",
      products: [
        "\u6C7D\u8F66\u7EBF\u675F",
        "\u6C7D\u8F66\u7EBF\u675F\u3001\u7535\u529B\u5DE5\u7A0B\u3001\u5149\u4F20\u8F93\u8BBE\u5907\u3001\u901A\u4FE1\u7535\u7F06\u53CA\u5149\u7F06\u3001\u4FE1\u606F\u79D1\u6280\u5E94\u7528\u670D\u52A1"
      ]
    },
    {
      code: "600111.SH",
      name: "\u5317\u65B9\u7A00\u571F",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u7A00\u571F",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u7A00\u6709\u91D1\u5C5E",
        "\u7A00\u571F"
      ],
      mainBusiness: "\u7A00\u571F\u7CBE\u77FF,\u7A00\u571F\u6DF1\u52A0\u5DE5\u4EA7\u54C1,\u7A00\u571F\u65B0\u6750\u6599\u751F\u4EA7\u4E0E\u9500\u552E,\u7A00\u571F\u9AD8\u79D1\u6280\u5E94\u7528\u4EA7\u54C1\u7684\u5F00\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E;\u7A00\u571F\u6280\u672F\u8F6C\u8BA9\u7B49",
      products: [
        "\u7A00\u571F\u529F\u80FD\u6750\u6599\u53CA\u5E94\u7528\u4EA7\u54C1",
        "\u7A00\u571F\u91D1\u5C5E\u3001\u6709\u8272\u91D1\u5C5E\u8D38\u6613\u3001\u73AF\u4FDD\u8BBE\u5907"
      ]
    },
    {
      code: "600115.SH",
      name: "\u4E2D\u56FD\u4E1C\u822A",
      availability: "available",
      industry: "\u4EA4\u901A\u8FD0\u8F93-\u822A\u7A7A\u673A\u573A-\u822A\u7A7A",
      industryLevels: [
        "\u4EA4\u901A\u8FD0\u8F93",
        "\u822A\u7A7A\u673A\u573A",
        "\u822A\u7A7A"
      ],
      mainBusiness: "\u56FD\u5185\u548C\u7ECF\u6279\u51C6\u7684\u56FD\u9645\u3001\u5730\u533A\u822A\u7A7A\u5BA2\u3001\u8D27\u3001\u90AE\u3001\u884C\u674E\u8FD0\u8F93\u4E1A\u52A1\u53CA\u5EF6\u4F38\u670D\u52A1\u3002\u6B64\u5916,\u516C\u53F8\u8FD8\u83B7\u51C6\u5F00\u5C55\u4EE5\u4E0B\u4E1A\u52A1\u7ECF\u8425:\u901A\u7528\u822A\u7A7A\u4E1A\u52A1;\u822A\u7A7A\u5668\u7EF4\u4FEE;\u822A\u7A7A\u8BBE\u5907\u5236\u9020\u4E0E\u7EF4\u4FEE;\u56FD\u5185\u5916\u822A\u7A7A\u516C\u53F8\u7684\u4EE3\u7406\u4E1A\u52A1;\u4E0E\u822A\u7A7A\u8FD0\u8F93\u6709\u5173\u7684\u5176\u4ED6\u4E1A\u52A1;\u4FDD\u9669\u517C\u4E1A\u4EE3\u7406\u670D\u52A1;\u7535\u5B50\u5546\u52A1;\u7A7A\u4E2D\u8D85\u5E02;\u5546\u54C1\u6279\u53D1\u3001\u96F6\u552E",
      products: [
        "\u822A\u7A7A\u8FD0\u8F93\u4E1A\u52A1",
        "\u822A\u7A7A\u5BA2\u8FD0\u3001\u822A\u7A7A\u8D27\u90AE\u8FD0\u3001\u822A\u7A7A\u5BA2\u8FD0"
      ]
    },
    {
      code: "600141.SH",
      name: "\u5174\u53D1\u96C6\u56E2",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u539F\u6599-\u78F7\u5316\u5DE5",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u5B66\u539F\u6599",
        "\u78F7\u5316\u5DE5"
      ],
      mainBusiness: "\u4E13\u6CE8\u4E8E\u7CBE\u7EC6\u78F7\u5316\u5DE5\u53D1\u5C55\u4E3B\u7EBF,\u79EF\u6781\u63A2\u7D22\u78F7\u3001\u7845\u3001\u786B\u3001\u76D0\u3001\u6C1F\u878D\u5408\u53D1\u5C55,\u4E0D\u65AD\u5B8C\u5584\u4E0A\u4E0B\u6E38\u4E00\u4F53\u5316\u4EA7\u4E1A\u94FE\u6761",
      products: [
        "\u77FF\u5C71\u91C7\u9009",
        "\u7535\u5B50\u5316\u5B66\u54C1\u3001\u519C\u836F\u3001\u78F7\u80A5\u3001\u78F7\u77FF\u77F3\u3001\u5316\u5DE5\u4EA7\u54C1\u8D38\u6613\u3001\u6709\u673A\u7845\u3001\u7535\u6C60\u6750\u6599"
      ]
    },
    {
      code: "600150.SH",
      name: "\u4E2D\u56FD\u8239\u8236",
      availability: "available",
      industry: "\u56FD\u9632\u4E0E\u88C5\u5907-\u8239\u8236\u4E0E\u6D77\u6D0B\u88C5\u5907-\u8239\u8236\u5236\u9020",
      industryLevels: [
        "\u56FD\u9632\u4E0E\u88C5\u5907",
        "\u8239\u8236\u4E0E\u6D77\u6D0B\u88C5\u5907",
        "\u8239\u8236\u5236\u9020"
      ],
      mainBusiness: "\u9020\u8239\u4E1A\u52A1(\u519B\u3001\u6C11)\u3001\u4FEE\u8239\u4E1A\u52A1\u3001\u6D77\u6D0B\u5DE5\u7A0B\u53CA\u673A\u7535\u8BBE\u5907\u7B49",
      products: [
        "\u8239\u8236\u9020\u4FEE",
        "\u822A\u6D77\u88C5\u5907\u3001\u8239\u8236\u914D\u5957\u8BBE\u5907"
      ]
    },
    {
      code: "600160.SH",
      name: "\u5DE8\u5316\u80A1\u4EFD",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u539F\u6599-\u6C1F\u5316\u5DE5",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u5B66\u539F\u6599",
        "\u6C1F\u5316\u5DE5"
      ],
      mainBusiness: "\u57FA\u672C\u5316\u5DE5\u539F\u6599\u3001\u98DF\u54C1\u5305\u88C5\u6750\u6599\u3001\u6C1F\u5316\u5DE5\u539F\u6599\u53CA\u540E\u7EED\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u5236\u51B7\u5242",
        "\u542B\u6C1F\u5236\u51B7\u5242\u3001\u5176\u4ED6\u5316\u5DE5\u4EA7\u54C1\u3001\u5176\u4ED6\u5316\u5DE5\u4EA7\u54C1\u3001\u5176\u4ED6\u5316\u5DE5\u4EA7\u54C1\u3001\u5176\u4ED6\u5316\u5DE5\u4EA7\u54C1\u3001\u5176\u4ED6\u5316\u5DE5\u4EA7\u54C1\u3001\u542B\u6C1F\u7CBE\u7EC6\u5316\u5B66\u54C1\u3001\u5DE5\u7A0B\u7BA1\u7406"
      ]
    },
    {
      code: "600176.SH",
      name: "\u4E2D\u56FD\u5DE8\u77F3",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102-\u73BB\u7EA4",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102",
        "\u73BB\u7EA4"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u73BB\u7483\u7EA4\u7EF4\u53CA\u5236\u54C1\u7684\u751F\u4EA7\u3001\u9500\u552E",
      products: [
        "\u73BB\u7EA4\u53CA\u5236\u54C1",
        "\u73BB\u7483\u7EA4\u7EF4"
      ]
    },
    {
      code: "600183.SH",
      name: "\u751F\u76CA\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u8BBE\u8BA1\u3001\u751F\u4EA7\u548C\u9500\u552E\u8986\u94DC\u677F\u548C\u7C98\u7ED3\u7247\u3001\u5370\u5236\u7EBF\u8DEF\u677F",
      products: [
        "\u8986\u94DC\u677F\u3001\u5370\u5236\u7535\u8DEF\u677F\u3001\u623F\u5730\u4EA7\u5F00\u53D1"
      ]
    },
    {
      code: "600188.SH",
      name: "\u5156\u77FF\u80FD\u6E90",
      availability: "available",
      industry: "\u5316\u77F3\u80FD\u6E90-\u7164\u70AD-\u7164\u70AD\u5F00\u91C7\u6D17\u9009",
      industryLevels: [
        "\u5316\u77F3\u80FD\u6E90",
        "\u7164\u70AD",
        "\u7164\u70AD\u5F00\u91C7\u6D17\u9009"
      ],
      mainBusiness: "\u7164\u70AD\u5F00\u91C7\u53CA\u9500\u552E\u3001\u7164\u5316\u5DE5\u4EA7\u54C1\u7684\u751F\u4EA7\u53CA\u9500\u552E\u3001\u7269\u6D41\u8FD0\u8F93\u4E1A\u52A1\u4EE5\u53CA\u8BBE\u5907\u5236\u9020\u548C\u7535\u529B\u4E1A\u52A1\u7B49",
      products: [
        "\u7164\u70AD\u4E1A\u52A1",
        "\u7164\u70AD\u3001\u7164\u5316\u5DE5\u3001\u94C1\u8DEF\u8D27\u8FD0\u3001\u706B\u529B\u53D1\u7535"
      ]
    },
    {
      code: "600256.SH",
      name: "\u5E7F\u6C47\u80FD\u6E90",
      availability: "available",
      industry: "\u5316\u77F3\u80FD\u6E90-\u77F3\u6CB9\u5929\u7136\u6C14-\u77F3\u6CB9\u52A0\u5DE5",
      industryLevels: [
        "\u5316\u77F3\u80FD\u6E90",
        "\u77F3\u6CB9\u5929\u7136\u6C14",
        "\u77F3\u6CB9\u52A0\u5DE5"
      ],
      mainBusiness: "LNG\u4E1A\u52A1,\u7164\u5316\u5DE5\u4E1A\u52A1,\u7164\u70AD\u4E1A\u52A1",
      products: [
        "\u7164\u70AD\u9500\u552E",
        "\u539F\u7164\u3001\u5929\u7136\u6C14\u8D38\u6613\u3001\u7164\u5316\u5DE5"
      ]
    },
    {
      code: "600276.SH",
      name: "\u6052\u745E\u533B\u836F",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u5316\u5B66\u5236\u836F-\u5316\u5B66\u5236\u5242",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u5316\u5B66\u5236\u836F",
        "\u5316\u5B66\u5236\u5242"
      ],
      mainBusiness: "\u836F\u54C1\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u80BF\u7624",
        "\u6297\u80BF\u7624\u6CBB\u7597\u836F\u3001\u795E\u7ECF\u7CFB\u7EDF\u7528\u836F\u3001\u9020\u5F71\u5242\u3001\u5FC3\u8111\u8840\u7BA1\u7528\u5316\u836F\u3001\u547C\u5438\u7CFB\u7EDF\u7528\u5316\u836F"
      ]
    },
    {
      code: "600298.SH",
      name: "\u5B89\u742A\u9175\u6BCD",
      availability: "available",
      industry: "\u98DF\u54C1\u996E\u6599-\u98DF\u54C1-\u98DF\u54C1\u7EFC\u5408",
      industryLevels: [
        "\u98DF\u54C1\u996E\u6599",
        "\u98DF\u54C1",
        "\u98DF\u54C1\u7EFC\u5408"
      ],
      mainBusiness: "\u9762\u5305\u9175\u6BCD\u3001\u4E2D\u534E\u9762\u98DF\u9175\u6BCD\u3001\u9175\u6BCD\u62BD\u63D0\u7269\u3001\u917F\u9152\u9175\u6BCD\u3001\u751F\u7269\u9972\u6599\u6DFB\u52A0\u5242\u3001\u8425\u517B\u4FDD\u5065\u4EA7\u54C1\u3001\u98DF\u54C1\u539F\u6599\u7B49\u4EA7\u54C1\u7684\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u9175\u6BCD\u7CFB\u5217",
        "\u9175\u6BCD\u3001\u7CD6\u3001\u5851\u6599\u8F6F\u5305\u88C5\u888B"
      ]
    },
    {
      code: "600309.SH",
      name: "\u4E07\u534E\u5316\u5B66",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u539F\u6599-\u805A\u6C28\u916F",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u5B66\u539F\u6599",
        "\u805A\u6C28\u916F"
      ],
      mainBusiness: "\u5316\u5DE5\u548C\u7CBE\u7EC6\u5316\u5B66\u54C1\u53CA\u65B0\u6750\u6599\u4EA7\u54C1\u7684\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u805A\u6C28\u916F\u7CFB\u5217",
        "\u5176\u4ED6\u7279\u79CD\u5316\u5B66\u5236\u54C1\u3001\u805A\u6C28\u916F\u3001\u6709\u673A\u5316\u5DE5"
      ]
    },
    {
      code: "600323.SH",
      name: "\u701A\u84DD\u73AF\u5883",
      availability: "available",
      industry: "\u516C\u7528\u4E8B\u4E1A-\u73AF\u4FDD-\u73AF\u4FDD",
      industryLevels: [
        "\u516C\u7528\u4E8B\u4E1A",
        "\u73AF\u4FDD",
        "\u73AF\u4FDD"
      ],
      mainBusiness: "\u56FA\u5E9F\u5904\u7406\u4E1A\u52A1\u3001\u80FD\u6E90\u4E1A\u52A1\u3001\u4F9B\u6C34\u4E1A\u52A1\u548C\u6392\u6C34\u4E1A\u52A1",
      products: [
        "\u56FA\u5E9F\u5904\u7406\u4E1A\u52A1",
        "\u56FA\u5E9F\u6CBB\u7406\u3001\u5929\u7136\u6C14\u4F9B\u5E94\u3001\u73AF\u536B\u670D\u52A1\u3001\u4F9B\u6C34\u3001\u73AF\u5883\u6CBB\u7406\u3001\u7ED9\u6392\u6C34\u5DE5\u7A0B\u3001\u73AF\u5883\u6CBB\u7406"
      ]
    },
    {
      code: "600426.SH",
      name: "\u534E\u9C81\u6052\u5347",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u80A5\u519C\u836F-\u6C2E\u80A5",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u80A5\u519C\u836F",
        "\u6C2E\u80A5"
      ],
      mainBusiness: "\u57FA\u7840\u5316\u5B66\u539F\u6599\u5236\u9020;\u5316\u5DE5\u4EA7\u54C1\u751F\u4EA7\u548C\u9500\u552E;\u4E13\u7528\u5316\u5B66\u4EA7\u54C1\u5236\u9020\u548C\u9500\u552E;\u80A5\u6599\u751F\u4EA7\u3001\u5316\u80A5\u9500\u552E;\u5408\u6210\u6750\u6599\u5236\u9020\u548C\u9500\u552E;\u5371\u5316\u54C1\u751F\u4EA7\u548C\u7ECF\u8425;\u53D1\u7535\u3001\u4F9B\u7535\u4E1A\u52A1;\u70ED\u529B\u751F\u4EA7\u548C\u4F9B\u5E94\u7B49\u3002",
      products: [
        "\u5316\u5B66\u80A5\u6599",
        "\u5176\u4ED6\u6709\u673A\u9178\u3001\u5316\u80A5\u3001\u4E59\u9178\u3001\u6709\u673A\u80FA"
      ]
    },
    {
      code: "600460.SH",
      name: "\u58EB\u5170\u5FAE",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u4E13\u6CE8\u4E8E\u7845\u534A\u5BFC\u4F53\u3001\u5316\u5408\u7269\u534A\u5BFC\u4F53\u4EA7\u54C1\u7684\u8BBE\u8BA1\u4E0E\u5236\u9020,\u5411\u5BA2\u6237\u63D0\u4F9B\u9AD8\u8D28\u91CF\u7684\u7845\u57FA\u96C6\u6210\u7535\u8DEF\u3001\u5206\u7ACB\u5668\u4EF6\u548C\u5316\u5408\u7269\u534A\u5BFC\u4F53\u5668\u4EF6(LED\u82AF\u7247\u548C\u6210\u54C1,SiC\u3001GaN\u529F\u7387\u5668\u4EF6)\u4EA7\u54C1\u3002",
      products: [
        "\u96C6\u6210\u7535\u8DEF",
        "\u5206\u7ACB\u5668\u4EF6\u3001\u96C6\u6210\u7535\u8DEF\u3001LED\u5C01\u88C5"
      ]
    },
    {
      code: "600482.SH",
      name: "\u4E2D\u56FD\u52A8\u529B",
      availability: "available",
      industry: "\u56FD\u9632\u4E0E\u88C5\u5907-\u8239\u8236\u4E0E\u6D77\u6D0B\u88C5\u5907-\u8239\u8236\u5236\u9020",
      industryLevels: [
        "\u56FD\u9632\u4E0E\u88C5\u5907",
        "\u8239\u8236\u4E0E\u6D77\u6D0B\u88C5\u5907",
        "\u8239\u8236\u5236\u9020"
      ],
      mainBusiness: "\u71C3\u6C14\u52A8\u529B\u3001\u84B8\u6C7D\u52A8\u529B\u3001\u67F4\u6CB9\u673A\u52A8\u529B\u3001\u7EFC\u5408\u7535\u529B\u3001\u5316\u5B66\u52A8\u529B\u3001\u70ED\u6C14\u673A\u52A8\u529B\u3001\u6838\u52A8\u529B(\u8BBE\u5907)\u7B49\u4E03\u7C7B\u52A8\u529B\u4E1A\u52A1\u53CA\u673A\u7535\u914D\u5957\u4E1A\u52A1,\u662F\u96C6\u9AD8\u7AEF\u52A8\u529B\u88C5\u5907\u7814\u53D1\u3001\u5236\u9020\u3001\u7CFB\u7EDF\u96C6\u6210\u3001\u9500\u552E\u53CA\u670D\u52A1\u4E8E\u4E00\u4F53\u7684\u4E00\u7AD9\u5F0F\u52A8\u529B\u9700\u6C42\u89E3\u51B3\u65B9\u6848\u4F9B\u5E94\u5546",
      products: [
        "\u67F4\u6CB9\u52A8\u529B",
        "\u53D1\u7535\u8BBE\u5907\u3001\u8239\u8236\u7528\u67F4\u6CB9\u673A\u3001\u94C5\u9178\u84C4\u7535\u6C60\u3001\u822A\u6D77\u88C5\u5907\u3001\u5176\u4ED6\u8D35\u91D1\u5C5E\u52A0\u5DE5\u4EA7\u54C1\u3001\u9F7F\u8F6E\u4F20\u52A8\u88C5\u7F6E\u3001\u71C3\u6C14\u8F6E\u673A\u3001\u6838\u7535\u8BBE\u5907\u3001\u7535\u529B\u751F\u4EA7\u3001\u706B\u7535\u8BBE\u5907"
      ]
    },
    {
      code: "600487.SH",
      name: "\u4EA8\u901A\u5149\u7535",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8BBE\u5907-\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u901A\u4FE1\u8BBE\u5907",
        "\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907"
      ],
      mainBusiness: "\u901A\u4FE1\u7F51\u7EDC\u4E1A\u52A1,\u80FD\u6E90\u4E92\u8054\u4E1A\u52A1",
      products: [
        "\u667A\u80FD\u7535\u7F51",
        "\u7535\u529B\u7535\u7F06\u3001\u7535\u529B\u7535\u7F06\u3001\u7535\u529B\u7535\u7F06\u3001\u7535\u529B\u7535\u7F06\u3001\u901A\u4FE1\u7535\u7F06\u53CA\u5149\u7F06"
      ]
    },
    {
      code: "600489.SH",
      name: "\u4E2D\u91D1\u9EC4\u91D1",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u8D35\u91D1\u5C5E-\u9EC4\u91D1",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u8D35\u91D1\u5C5E",
        "\u9EC4\u91D1"
      ],
      mainBusiness: "\u9EC4\u91D1\u3001\u6709\u8272\u91D1\u5C5E\u7684\u5730\u8D28\u52D8\u67E5\u3001\u91C7\u9009\u3001\u51B6\u70BC\u7684\u6295\u8D44\u4E0E\u7BA1\u7406;\u9EC4\u91D1\u751F\u4EA7\u7684\u526F\u4EA7\u54C1\u52A0\u5DE5\u3001\u9500\u552E;\u9EC4\u91D1\u751F\u4EA7\u6240\u9700\u539F\u6750\u6599\u3001\u71C3\u6599\u3001\u8BBE\u5907\u7684\u4ED3\u50A8\u3001\u9500\u552E;\u9EC4\u91D1\u751F\u4EA7\u6280\u672F\u7684\u7814\u7A76\u5F00\u53D1\u3001\u54A8\u8BE2\u670D\u52A1;\u9AD8\u7EAF\u5EA6\u9EC4\u91D1\u5236\u54C1\u7684\u751F\u4EA7\u3001\u52A0\u5DE5\u3001\u6279\u53D1;\u8FDB\u51FA\u53E3\u4E1A\u52A1;\u5546\u54C1\u5C55\u9500\u3002",
      products: [
        "\u91D1",
        "\u9EC4\u91D1\u3001\u94DC"
      ]
    },
    {
      code: "600498.SH",
      name: "\u70FD\u706B\u901A\u4FE1",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8BBE\u5907-\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u901A\u4FE1\u8BBE\u5907",
        "\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907"
      ],
      mainBusiness: "\u5149\u901A\u4FE1\u7CFB\u7EDF\u3001\u5149\u7EA4\u5149\u7F06\u3001\u5149\u7535\u5B50\u5668\u4EF6",
      products: [
        "\u901A\u4FE1\u7CFB\u7EDF\u8BBE\u5907",
        "\u5149\u4F20\u8F93\u8BBE\u5907\u3001\u5149\u7F06\u3001\u901A\u4FE1\u63A5\u5165\u8BBE\u5907"
      ]
    },
    {
      code: "600519.SH",
      name: "\u8D35\u5DDE\u8305\u53F0",
      availability: "available",
      industry: "\u98DF\u54C1\u996E\u6599-\u996E\u6599-\u767D\u9152",
      industryLevels: [
        "\u98DF\u54C1\u996E\u6599",
        "\u996E\u6599",
        "\u767D\u9152"
      ],
      mainBusiness: "\u8305\u53F0\u9152\u53CA\u7CFB\u5217\u9152\u7684\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u8305\u53F0\u9152",
        "\u767D\u9152\u3001\u767D\u9152"
      ]
    },
    {
      code: "600522.SH",
      name: "\u4E2D\u5929\u79D1\u6280",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8BBE\u5907-\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u901A\u4FE1\u8BBE\u5907",
        "\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907"
      ],
      mainBusiness: "\u901A\u4FE1\u3001\u7535\u529B\u3001\u6D77\u6D0B\u3001\u65B0\u80FD\u6E90\u7B49\u9886\u57DF\u4EA7\u54C1\u7684\u751F\u4EA7\u4E0E\u9500\u552E,\u53CA\u6D77\u6D0B\u5DE5\u7A0B\u65BD\u5DE5\u7B49\u7ECF\u8425\u6D3B\u52A8",
      products: [
        "\u7535\u7F51\u5EFA\u8BBE",
        "\u7535\u529B\u7535\u7F06\u3001\u94DC\u6750\u3001\u5149\u7EA4\u5149\u7F06\u3001\u8239\u6D77\u5DE5\u7A0B\u3001\u5149\u4F0F\u7EC4\u4EF6\u3001\u6C7D\u8F66\u96F6\u4EF6\u4E0E\u8BBE\u5907"
      ]
    },
    {
      code: "600547.SH",
      name: "\u5C71\u4E1C\u9EC4\u91D1",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u8D35\u91D1\u5C5E-\u9EC4\u91D1",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u8D35\u91D1\u5C5E",
        "\u9EC4\u91D1"
      ],
      mainBusiness: "\u9EC4\u91D1\u53CA\u6709\u8272\u91D1\u5C5E\u7684\u52D8\u67E5\u3001\u5F00\u91C7\u3001\u9009\u51B6\u3001\u9500\u552E,\u9EC4\u91D1\u77FF\u5C71\u4E13\u7528\u8BBE\u5907\u3001\u5EFA\u7B51\u88C5\u9970\u6750\u6599(\u4E0D\u542B\u56FD\u5BB6\u6CD5\u5F8B\u6CD5\u89C4\u9650\u5236\u4EA7\u54C1)\u7684\u751F\u4EA7\u3001\u52A0\u5DE5\u548C\u9500\u552E",
      products: [
        "\u81EA\u4EA7\u91D1",
        "\u6709\u8272\u91D1\u5C5E\u8D38\u6613\u3001\u9EC4\u91D1\u3001\u91D1\u6761\u3001\u6709\u8272\u91D1\u5C5E\u8D38\u6613"
      ]
    },
    {
      code: "600549.SH",
      name: "\u53A6\u95E8\u94A8\u4E1A",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u94A8",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u7A00\u6709\u91D1\u5C5E",
        "\u94A8"
      ],
      mainBusiness: "\u94A8\u94BC\u3001\u7A00\u571F\u548C\u80FD\u6E90\u65B0\u6750\u6599",
      products: [
        "\u94A8\u94BC\u7B49\u6709\u8272\u91D1\u5C5E\u5236\u54C1",
        "\u7535\u6C60\u6750\u6599\u3001\u94A8\u3001\u7A00\u571F\u91D1\u5C5E\u3001\u5546\u54C1\u623F\u5F00\u53D1"
      ]
    },
    {
      code: "600584.SH",
      name: "\u957F\u7535\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u662F\u5168\u7403\u9886\u5148\u7684\u96C6\u6210\u7535\u8DEF\u5236\u9020\u548C\u6280\u672F\u670D\u52A1\u63D0\u4F9B\u5546,\u63D0\u4F9B\u5168\u65B9\u4F4D\u7684\u82AF\u7247\u6210\u54C1\u5236\u9020\u4E00\u7AD9\u5F0F\u670D\u52A1,\u5305\u62EC\u96C6\u6210\u7535\u8DEF\u7684\u7CFB\u7EDF\u96C6\u6210\u3001\u8BBE\u8BA1\u4EFF\u771F\u3001\u6280\u672F\u5F00\u53D1\u3001\u4EA7\u54C1\u8BA4\u8BC1\u3001\u6676\u5706\u4E2D\u6D4B\u3001\u6676\u5706\u7EA7\u4E2D\u9053\u5C01\u88C5\u6D4B\u8BD5\u3001\u7CFB\u7EDF\u7EA7\u5C01\u88C5\u6D4B\u8BD5\u3001\u82AF\u7247\u6210\u54C1\u6D4B\u8BD5\u5E76\u53EF\u5411\u4E16\u754C\u5404\u5730\u7684\u534A\u5BFC\u4F53\u5BA2\u6237\u63D0\u4F9B\u76F4\u8FD0\u670D\u52A1",
      products: [
        "\u82AF\u7247\u5C01\u6D4B",
        "\u534A\u5BFC\u4F53\u5C01\u6D4B\u670D\u52A1"
      ]
    },
    {
      code: "600660.SH",
      name: "\u798F\u8000\u73BB\u7483",
      availability: "available",
      industry: "\u4EA4\u8FD0\u8BBE\u5907-\u6C7D\u8F66-\u6C7D\u8F66\u96F6\u90E8\u4EF6",
      industryLevels: [
        "\u4EA4\u8FD0\u8BBE\u5907",
        "\u6C7D\u8F66",
        "\u6C7D\u8F66\u96F6\u90E8\u4EF6"
      ],
      mainBusiness: "\u5404\u79CD\u4EA4\u901A\u8FD0\u8F93\u5DE5\u5177\u63D0\u4F9B\u5B89\u5168\u73BB\u7483\u548C\u6C7D\u8F66\u9970\u4EF6\u5168\u89E3\u51B3\u65B9\u6848,\u5305\u62EC\u6C7D\u8F66\u7EA7\u6D6E\u6CD5\u73BB\u7483\u3001\u6C7D\u8F66\u73BB\u7483\u3001\u673A\u8F66\u73BB\u7483\u3001\u884C\u674E\u67B6\u3001\u8F66\u7A97\u9970\u4EF6\u76F8\u5173\u7684\u8BBE\u8BA1\u3001\u751F\u4EA7\u3001\u9500\u552E\u53CA\u670D\u52A1",
      products: [
        "\u6C7D\u8F66\u73BB\u7483",
        "\u6C7D\u8F66\u73BB\u7483\u3001\u6D6E\u6CD5\u73BB\u7483"
      ]
    },
    {
      code: "600674.SH",
      name: "\u5DDD\u6295\u80FD\u6E90",
      availability: "available",
      industry: "\u516C\u7528\u4E8B\u4E1A-\u7535\u529B-\u6C34\u7535",
      industryLevels: [
        "\u516C\u7528\u4E8B\u4E1A",
        "\u7535\u529B",
        "\u6C34\u7535"
      ],
      mainBusiness: "\u6295\u8D44\u5F00\u53D1\u3001\u7ECF\u8425\u7BA1\u7406\u6E05\u6D01\u80FD\u6E90\u4E3A\u4E3B\u4E1A,\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E\u8F68\u9053\u4EA4\u901A\u7535\u6C14\u81EA\u52A8\u5316\u7CFB\u7EDF,\u751F\u4EA7\u7ECF\u8425\u5149\u7EA4\u5149\u7F06\u7B49\u9AD8\u65B0\u6280\u672F\u4EA7\u54C1\u3002",
      products: [
        "\u7535\u529B",
        "\u6C34\u529B\u53D1\u7535\u3001\u7535\u529B\u884C\u4E1A\u5E94\u7528\u8F6F\u4EF6\u3001\u7535\u5B50\u8BBE\u5907\u3001\u4FE1\u606F\u79D1\u6280\u54A8\u8BE2\u4E0E\u5176\u4ED6\u670D\u52A1"
      ]
    },
    {
      code: "600690.SH",
      name: "\u6D77\u5C14\u667A\u5BB6",
      availability: "available",
      industry: "\u5BB6\u7535-\u767D\u8272\u5BB6\u7535-\u767D\u8272\u5BB6\u7535",
      industryLevels: [
        "\u5BB6\u7535",
        "\u767D\u8272\u5BB6\u7535",
        "\u767D\u8272\u5BB6\u7535"
      ],
      mainBusiness: "\u5BB6\u7535\u7684\u7814\u53D1\u3001\u751F\u4EA7\u53CA\u9500\u552E\u5DE5\u4F5C,\u6D89\u53CA\u51B0\u7BB1/\u51B7\u67DC\u3001\u53A8\u7535\u3001\u7A7A\u8C03\u3001\u6D17\u8863\u8BBE\u5907\u3001\u6C34\u5BB6\u7535\u53CA\u5176\u4ED6\u667A\u80FD\u5BB6\u5EAD\u4E1A\u52A1,\u4EE5\u53CA\u63D0\u4F9B\u667A\u80FD\u5BB6\u5EAD\u5168\u5957\u5316\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u7535\u51B0\u7BB1",
        "\u51B0\u7BB1\u3001\u6D17\u8863\u673A\u3001\u7A7A\u8C03\u3001\u53A8\u623F\u7535\u5668\u3001\u5BB6\u7528\u7535\u5668\u96F6\u552E\u3001\u70ED\u6C34\u5668"
      ]
    },
    {
      code: "600809.SH",
      name: "\u5C71\u897F\u6C7E\u9152",
      availability: "available",
      industry: "\u98DF\u54C1\u996E\u6599-\u996E\u6599-\u767D\u9152",
      industryLevels: [
        "\u98DF\u54C1\u996E\u6599",
        "\u996E\u6599",
        "\u767D\u9152"
      ],
      mainBusiness: "\u6C7E\u9152\u3001\u7AF9\u53F6\u9752\u9152\u3001\u674F\u82B1\u6751\u7CFB\u5217\u9152\u7684\u751F\u4EA7\u3001\u9500\u552E",
      products: [
        "\u9152\u7C7B\u9500\u552E",
        "\u6E05\u9999\u578B\u767D\u9152\u3001\u767D\u9152"
      ]
    },
    {
      code: "600885.SH",
      name: "\u5B8F\u53D1\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u8F93\u53D8\u7535\u8BBE\u5907-\u7535\u6C14\u81EA\u63A7\u8BBE\u5907",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u8F93\u53D8\u7535\u8BBE\u5907",
        "\u7535\u6C14\u81EA\u63A7\u8BBE\u5907"
      ],
      mainBusiness: "\u7EE7\u7535\u5668\u548C\u9AD8\u4F4E\u538B\u7535\u5668\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u7EE7\u7535\u5668",
        "\u7EE7\u7535\u5668\u3001\u7535\u6C14\u90E8\u4EF6\u4E0E\u8BBE\u5907"
      ]
    },
    {
      code: "600886.SH",
      name: "\u56FD\u6295\u7535\u529B",
      availability: "available",
      industry: "\u516C\u7528\u4E8B\u4E1A-\u7535\u529B-\u6C34\u7535",
      industryLevels: [
        "\u516C\u7528\u4E8B\u4E1A",
        "\u7535\u529B",
        "\u6C34\u7535"
      ],
      mainBusiness: "\u6295\u8D44\u5EFA\u8BBE\u3001\u7ECF\u8425\u7BA1\u7406\u4EE5\u7535\u529B\u751F\u4EA7\u4E3A\u4E3B\u7684\u80FD\u6E90\u9879\u76EE;\u5F00\u53D1\u7ECF\u8425\u65B0\u80FD\u6E90\u9879\u76EE\u3001\u9AD8\u65B0\u6280\u672F\u3001\u73AF\u4FDD\u4EA7\u4E1A;\u5F00\u53D1\u548C\u7ECF\u8425\u7535\u529B\u914D\u5957\u4EA7\u54C1\u53CA\u4FE1\u606F\u3001\u54A8\u8BE2\u670D\u52A1",
      products: [
        "\u7535\u529B",
        "\u7535\u529B\u751F\u4EA7"
      ]
    },
    {
      code: "600887.SH",
      name: "\u4F0A\u5229\u80A1\u4EFD",
      availability: "available",
      industry: "\u98DF\u54C1\u996E\u6599-\u98DF\u54C1-\u4E73\u5236\u54C1",
      industryLevels: [
        "\u98DF\u54C1\u996E\u6599",
        "\u98DF\u54C1",
        "\u4E73\u5236\u54C1"
      ],
      mainBusiness: "\u5404\u7C7B\u4E73\u54C1\u53CA\u5065\u5EB7\u996E\u54C1\u7684\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u6DB2\u4F53\u4E73",
        "\u6DB2\u6001\u5976\u3001\u5976\u7C89\u3001\u51B0\u6DC7\u6DCB"
      ]
    },
    {
      code: "600893.SH",
      name: "\u822A\u53D1\u52A8\u529B",
      availability: "available",
      industry: "\u56FD\u9632\u4E0E\u88C5\u5907-\u822A\u7A7A\u822A\u5929\u88C5\u5907-\u822A\u5929\u88C5\u5907",
      industryLevels: [
        "\u56FD\u9632\u4E0E\u88C5\u5907",
        "\u822A\u7A7A\u822A\u5929\u88C5\u5907",
        "\u822A\u5929\u88C5\u5907"
      ],
      mainBusiness: "\u822A\u7A7A\u53D1\u52A8\u673A\u53CA\u884D\u751F\u4EA7\u54C1\u3001\u5916\u8D38\u51FA\u53E3\u8F6C\u5305\u4E1A\u52A1\u3001\u975E\u822A\u7A7A\u4EA7\u54C1\u53CA\u5176\u4ED6\u4E1A\u52A1",
      products: [
        "\u822A\u7A7A\u53D1\u52A8\u673A\u5236\u9020\u53CA\u884D\u751F\u4EA7\u54C1",
        "\u822A\u7A7A\u53D1\u52A8\u673A\u3001\u822A\u7A7A\u53D1\u52A8\u673A\u96F6\u90E8\u4EF6\u3001\u71C3\u6C14\u8F6E\u673A"
      ]
    },
    {
      code: "600900.SH",
      name: "\u957F\u6C5F\u7535\u529B",
      availability: "available",
      industry: "\u516C\u7528\u4E8B\u4E1A-\u7535\u529B-\u6C34\u7535",
      industryLevels: [
        "\u516C\u7528\u4E8B\u4E1A",
        "\u7535\u529B",
        "\u6C34\u7535"
      ],
      mainBusiness: "\u5927\u578B\u6C34\u7535\u8FD0\u8425",
      products: [
        "\u6C34\u7535",
        "\u6C34\u529B\u53D1\u7535"
      ]
    },
    {
      code: "600919.SH",
      name: "\u6C5F\u82CF\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C"
      ],
      mainBusiness: "1.\u5BF9\u516C\u4E1A\u52A1:\u670D\u52A1\u5B9E\u4F53\u7ECF\u6D4E\u3001\u7EFF\u8272\u91D1\u878D\u3001\u4EA4\u6613\u94F6\u884C\u3001\u666E\u60E0\u91D1\u878D\u3001\u8DE8\u5883\u91D1\u878D\u3001\u6295\u884C\u4E1A\u52A1\u3001\u7F51\u7EDC\u91D1\u878D;2.\u96F6\u552E\u4E1A\u52A1:\u8D22\u5BCC\u7BA1\u7406\u3001\u517B\u8001\u91D1\u878D\u3001\u6D88\u8D39\u91D1\u878D\u3001\u667A\u6167\u96F6\u552E;3.\u91D1\u878D\u5E02\u573A\u4E1A\u52A1:\u8D44\u91D1\u4E1A\u52A1\u3001\u540C\u4E1A\u4E1A\u52A1\u3001\u6258\u7BA1\u4E1A\u52A1;4.\u91D1\u878D\u79D1\u6280:\u52A0\u901F\u6570\u5B57\u91D1\u878D\u5EFA\u8BBE\u3001\u52A0\u5F3A\u6570\u5B57\u5316\u8FD0\u8425\u3001\u805A\u7126\u6838\u5FC3\u80FD\u529B\u6253\u9020",
      products: [
        "\u516C\u53F8\u91D1\u878D\u4E1A\u52A1",
        "\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C"
      ]
    },
    {
      code: "600926.SH",
      name: "\u676D\u5DDE\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C"
      ],
      mainBusiness: "\u516C\u53F8\u91D1\u878D\u4E1A\u52A1,\u96F6\u552E\u91D1\u878D\u4E1A\u52A1,\u5C0F\u5FAE\u91D1\u878D\u4E1A\u52A1,\u91D1\u878D\u5E02\u573A\u4E1A\u52A1,\u8D44\u4EA7\u7BA1\u7406\u4E1A\u52A1,\u7535\u5B50\u94F6\u884C\u4E1A\u52A1",
      products: [
        "\u516C\u53F8\u4E1A\u52A1",
        "\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C"
      ]
    },
    {
      code: "600938.SH",
      name: "\u4E2D\u56FD\u6D77\u6CB9",
      availability: "available",
      industry: "\u5316\u77F3\u80FD\u6E90-\u77F3\u6CB9\u5929\u7136\u6C14-\u77F3\u6CB9\u5929\u7136\u6C14\u5F00\u91C7",
      industryLevels: [
        "\u5316\u77F3\u80FD\u6E90",
        "\u77F3\u6CB9\u5929\u7136\u6C14",
        "\u77F3\u6CB9\u5929\u7136\u6C14\u5F00\u91C7"
      ],
      mainBusiness: "\u52D8\u63A2\u3001\u5F00\u53D1\u3001\u751F\u4EA7\u53CA\u9500\u552E\u539F\u6CB9\u548C\u5929\u7136\u6C14",
      products: [
        "\u6CB9\u6C14\u9500\u552E",
        "\u539F\u6CB9\u3001\u539F\u6CB9\u8D38\u6613"
      ]
    },
    {
      code: "600941.SH",
      name: "\u4E2D\u56FD\u79FB\u52A8",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8FD0\u8425-\u901A\u4FE1\u8FD0\u8425",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u901A\u4FE1\u8FD0\u8425",
        "\u901A\u4FE1\u8FD0\u8425"
      ],
      mainBusiness: "\u6DB5\u76D6\u5305\u62EC\u79FB\u52A8\u901A\u4FE1\u3001\u5BBD\u5E26\u7F51\u7EDC\u3001\u8702\u7A9D\u7269\u8054\u548C\u536B\u661F\u4E92\u8054\u7684\u901A\u4FE1\u670D\u52A1,\u6570\u636E\u4E2D\u5FC3\u3001\u79FB\u52A8\u4E91\u548C\u79FB\u52A8\u4E91\u5E94\u7528\u7684\u7B97\u529B\u670D\u52A1,\u4EE5\u53CA\u6570\u636E\u7B97\u6CD5\u3001\u5177\u8EAB\u667A\u80FD\u3001\u6570\u667A\u6587\u5316\u3001\u6570\u667A\u7535\u5546\u548C\u884C\u4E1A\u6570\u667A\u670D\u52A1\u7684\u667A\u80FD\u670D\u52A1",
      products: [
        "\u5176\u4ED6\u4E1A\u52A1",
        "\u6570\u636E\u6D41\u91CF\u670D\u52A1\u3001\u7EFC\u5408\u7535\u4FE1\u4E1A\u52A1\u3001\u56FA\u5B9A\u901A\u4FE1\u670D\u52A1\u3001\u79FB\u52A8\u8BDD\u97F3\u670D\u52A1\u3001\u77ED\u4FE1\u670D\u52A1"
      ]
    },
    {
      code: "600988.SH",
      name: "\u8D64\u5CF0\u9EC4\u91D1",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u8D35\u91D1\u5C5E-\u9EC4\u91D1",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u8D35\u91D1\u5C5E",
        "\u9EC4\u91D1"
      ],
      mainBusiness: "\u9EC4\u91D1\u7684\u5F00\u91C7\u3001\u9009\u77FF\u53CA\u9500\u552E",
      products: [
        "\u9EC4\u91D1",
        "\u767D\u94F6\u3001\u9EC4\u91D1\u3001\u7535\u89E3\u94DC\u3001\u5E9F\u5F03\u7535\u5668\u7535\u5B50\u62C6\u89E3\u56DE\u6536\u3001\u950C\u77FF\u3001\u7A00\u571F\u3001\u94BC\u77FF\u3001\u94DC\u77FF\u3001\u94C5\u77FF"
      ]
    },
    {
      code: "600999.SH",
      name: "\u62DB\u5546\u8BC1\u5238",
      availability: "available",
      industry: "\u91D1\u878D-\u975E\u94F6\u884C\u91D1\u878D-\u8BC1\u5238",
      industryLevels: [
        "\u91D1\u878D",
        "\u975E\u94F6\u884C\u91D1\u878D",
        "\u8BC1\u5238"
      ],
      mainBusiness: "\u516C\u53F8\u4EE5\u5BA2\u6237\u4E3A\u4E2D\u5FC3,\u5411\u4E2A\u4EBA\u3001\u673A\u6784\u53CA\u4F01\u4E1A\u5BA2\u6237\u63D0\u4F9B\u591A\u5143\u3001\u5168\u65B9\u4F4D\u7684\u91D1\u878D\u4EA7\u54C1\u548C\u670D\u52A1\u5E76\u4ECE\u4E8B\u6295\u8D44\u4E0E\u4EA4\u6613,\u4E3B\u8981\u4E1A\u52A1\u677F\u5757\u5305\u542B\u8D22\u5BCC\u7BA1\u7406\u548C\u673A\u6784\u4E1A\u52A1\u3001\u6295\u8D44\u94F6\u884C\u4E1A\u52A1\u3001\u6295\u8D44\u7BA1\u7406\u4E1A\u52A1\u3001\u6295\u8D44\u53CA\u4EA4\u6613\u4E1A\u52A1",
      products: [
        "\u8BC1\u5238\u7ECF\u7EAA\u4E1A\u52A1",
        "\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u5238\u5546\u81EA\u8425\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u6295\u8D44\u94F6\u884C\u4E1A\u3001\u59D4\u6258\u8D44\u4EA7\u7BA1\u7406\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1"
      ]
    },
    {
      code: "601006.SH",
      name: "\u5927\u79E6\u94C1\u8DEF",
      availability: "available",
      industry: "\u4EA4\u901A\u8FD0\u8F93-\u516C\u8DEF\u94C1\u8DEF-\u94C1\u8DEF\u8FD0\u8F93",
      industryLevels: [
        "\u4EA4\u901A\u8FD0\u8F93",
        "\u516C\u8DEF\u94C1\u8DEF",
        "\u94C1\u8DEF\u8FD0\u8F93"
      ],
      mainBusiness: "\u4E3B\u8981\u7ECF\u8425\u94C1\u8DEF\u5BA2\u3001\u8D27\u8FD0\u8F93\u4E1A\u52A1,\u540C\u65F6\u5411\u56FD\u5185\u5176\u4ED6\u94C1\u8DEF\u8FD0\u8F93\u4F01\u4E1A\u63D0\u4F9B\u670D\u52A1\u3002",
      products: [
        "\u5176\u4ED6\u4E1A\u52A1",
        "\u94C1\u8DEF\u8D27\u8FD0\u3001\u94C1\u8DEF\u5BA2\u8FD0"
      ]
    },
    {
      code: "601009.SH",
      name: "\u5357\u4EAC\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C"
      ],
      mainBusiness: "\u516C\u53F8\u94F6\u884C\u4E1A\u52A1\u3001\u4E2A\u4EBA\u94F6\u884C\u4E1A\u52A1\u3001\u8D44\u91D1\u4E1A\u52A1\u548C\u5176\u4ED6\u4E1A\u52A1\u7B49",
      products: [
        "\u516C\u53F8\u94F6\u884C\u4E1A\u52A1",
        "\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C"
      ]
    },
    {
      code: "601012.SH",
      name: "\u9686\u57FA\u7EFF\u80FD",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u7535\u6E90\u8BBE\u5907-\u592A\u9633\u80FD",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u7535\u6E90\u8BBE\u5907",
        "\u592A\u9633\u80FD"
      ],
      mainBusiness: "\u5355\u6676\u7845\u68D2\u548C\u7845\u7247\u3001\u7535\u6C60\u548C\u7EC4\u4EF6\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E,\u4EE5\u53CA\u5149\u4F0F\u7535\u7AD9\u7684\u5F00\u53D1\u8FD0\u8425\u7B49",
      products: [
        "\u5149\u4F0F\u7535\u7AD9",
        "\u5149\u4F0F\u53D1\u7535\u7CFB\u7EDF\u3001\u7845\u68D2\u3001\u5149\u4F0F\u7535\u7AD9EPC"
      ]
    },
    {
      code: "601021.SH",
      name: "\u6625\u79CB\u822A\u7A7A",
      availability: "available",
      industry: "\u4EA4\u901A\u8FD0\u8F93-\u822A\u7A7A\u673A\u573A-\u822A\u7A7A",
      industryLevels: [
        "\u4EA4\u901A\u8FD0\u8F93",
        "\u822A\u7A7A\u673A\u573A",
        "\u822A\u7A7A"
      ],
      mainBusiness: "\u56FD\u5185\u3001\u56FD\u9645\u53CA\u6E2F\u6FB3\u53F0\u822A\u7A7A\u5BA2\u8D27\u8FD0\u8F93\u4E1A\u52A1\u53CA\u4E0E\u822A\u7A7A\u8FD0\u8F93\u4E1A\u52A1\u76F8\u5173\u7684\u670D\u52A1\u3002",
      products: [
        "\u5176\u4ED6\u4E1A\u52A1",
        "\u822A\u7A7A\u5BA2\u8FD0\u3001\u822A\u7A7A\u8D27\u90AE\u8FD0"
      ]
    },
    {
      code: "601058.SH",
      name: "\u8D5B\u8F6E\u8F6E\u80CE",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u6A61\u80F6\u5236\u54C1-\u8F6E\u80CE",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u6A61\u80F6\u5236\u54C1",
        "\u8F6E\u80CE"
      ],
      mainBusiness: "\u8F6E\u80CE\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u8F6E\u80CE"
      ]
    },
    {
      code: "601077.SH",
      name: "\u6E1D\u519C\u5546\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C"
      ],
      mainBusiness: "\u666E\u60E0\u91D1\u878D\u4E1A\u52A1\u3001\u516C\u53F8\u91D1\u878D\u4E1A\u52A1\u3001\u91D1\u878D\u5E02\u573A\u4E1A\u52A1",
      products: [
        "\u516C\u53F8\u94F6\u884C\u4E1A\u52A1",
        "\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C"
      ]
    },
    {
      code: "601088.SH",
      name: "\u4E2D\u56FD\u795E\u534E",
      availability: "available",
      industry: "\u5316\u77F3\u80FD\u6E90-\u7164\u70AD-\u7164\u70AD\u5F00\u91C7\u6D17\u9009",
      industryLevels: [
        "\u5316\u77F3\u80FD\u6E90",
        "\u7164\u70AD",
        "\u7164\u70AD\u5F00\u91C7\u6D17\u9009"
      ],
      mainBusiness: "\u7164\u70AD\u3001\u7535\u529B\u7684\u751F\u4EA7\u548C\u9500\u552E,\u94C1\u8DEF\u3001\u6E2F\u53E3\u548C\u8239\u8236\u8FD0\u8F93,\u7164\u5236\u70EF\u70C3\u7B49\u4E1A\u52A1\u3002",
      products: [
        "\u5176\u4ED6\u4E1A\u52A1",
        "\u7164\u70AD\u3001\u706B\u529B\u53D1\u7535\u3001\u94C1\u8DEF\u8D27\u8FD0\u3001\u7164\u5316\u5DE5"
      ]
    },
    {
      code: "601100.SH",
      name: "\u6052\u7ACB\u6DB2\u538B",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u901A\u7528\u8BBE\u5907-\u57FA\u7840\u4EF6",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u901A\u7528\u8BBE\u5907",
        "\u57FA\u7840\u4EF6"
      ],
      mainBusiness: "\u4ECE\u4E8B\u6DB2\u538B\u4F20\u52A8\u63A7\u5236\u8BBE\u5907\u4E0E\u7CFB\u7EDF\u96C6\u6210\u7684\u7814\u53D1\u3001\u5236\u9020\u3001\u9500\u552E\u548C\u670D\u52A1\u5DE5\u4F5C,\u4E3B\u8981\u4EA7\u54C1\u5305\u62EC\u9AD8\u538B\u6CB9\u7F38\u3001\u9AD8\u538B\u67F1\u585E\u6CF5\u3001\u6DB2\u538B\u591A\u8DEF\u9600\u3001\u6DB2\u538B\u9A6C\u8FBE\u3001\u5DE5\u4E1A\u9600\u3001\u6DB2\u538B\u7CFB\u7EDF\u3001\u6DB2\u538B\u6D4B\u8BD5\u53F0\u53CA\u9AD8\u7CBE\u5BC6\u6DB2\u538B\u94F8\u4EF6\u7B49\u4EA7\u54C1\u3002\u6DB2\u538B\u5143\u4EF6\u53CA\u7CFB\u7EDF\u662F\u5927\u578B\u673A\u68B0\u7684\u6838\u5FC3\u4F20\u52A8\u88C5\u7F6E,\u516C\u53F8\u6DB2\u538B\u4EA7\u54C1\u4E0B\u6E38\u5E94\u7528\u9886\u57DF\u8986\u76D6\u884C\u8D70\u673A\u68B0\u3001\u96A7\u9053\u5DE5\u7A0B\u3001\u519C\u4E1A\u673A\u68B0\u3001\u5DE5\u4E1A\u5DE5\u7A0B\u3001\u6D77\u6D0B\u5DE5\u7A0B\u3001\u98CE\u7535\u5149\u4F0F\u65B0\u80FD\u6E90\u7B49\u884C\u4E1A\u4E0E\u9886\u57DF",
      products: [
        "\u6DB2\u538B\u6CF5\u9600",
        "\u6DB2\u538B\u7F38\u3001\u6DB2\u538B\u6CF5\u9600\u3001\u6DB2\u538B\u7CFB\u7EDF\u7ED3\u6784\u4EF6\u3001\u6DB2\u538B\u7CFB\u7EDF"
      ]
    },
    {
      code: "601111.SH",
      name: "\u4E2D\u56FD\u56FD\u822A",
      availability: "available",
      industry: "\u4EA4\u901A\u8FD0\u8F93-\u822A\u7A7A\u673A\u573A-\u822A\u7A7A",
      industryLevels: [
        "\u4EA4\u901A\u8FD0\u8F93",
        "\u822A\u7A7A\u673A\u573A",
        "\u822A\u7A7A"
      ],
      mainBusiness: "\u4EE5\u822A\u7A7A\u8FD0\u8F93\u4E3A\u6838\u5FC3\u4E3B\u4E1A,\u62A5\u544A\u671F\u5185\u8425\u4E1A\u6536\u5165\u4E3B\u8981\u7531\u822A\u7A7A\u5BA2\u8FD0\u3001\u822A\u7A7A\u8D27\u8FD0\u53CA\u90AE\u8FD0\u548C\u5176\u4ED6\u6536\u5165(\u5176\u4ED6\u6536\u5165\u4E3B\u8981\u4E3A\u98DE\u673A\u7EF4\u4FEE\u3001\u5730\u9762\u670D\u52A1\u7B49)\u6784\u6210\u3002",
      products: [
        "\u822A\u7A7A\u5BA2\u8FD0",
        "\u822A\u7A7A\u5BA2\u8FD0\u3001\u822A\u7A7A\u8D27\u90AE\u8FD0"
      ]
    },
    {
      code: "601138.SH",
      name: "\u5DE5\u4E1A\u5BCC\u8054",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u6D88\u8D39\u7535\u5B50\u8BBE\u5907-\u6D88\u8D39\u7535\u5B50\u8BBE\u5907",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u6D88\u8D39\u7535\u5B50\u8BBE\u5907",
        "\u6D88\u8D39\u7535\u5B50\u8BBE\u5907"
      ],
      mainBusiness: "\u516C\u53F8\u662F\u5168\u7403\u9886\u5148\u7684\u9AD8\u7AEF\u667A\u80FD\u5236\u9020\u53CA\u5DE5\u4E1A\u4E92\u8054\u7F51\u89E3\u51B3\u65B9\u6848\u670D\u52A1\u5546,\u4E3B\u8981\u4E1A\u52A1\u5305\u542B\u4E91\u8BA1\u7B97\u3001\u901A\u4FE1\u7F51\u7EDC\u53CA\u79FB\u52A8\u7F51\u7EDC\u8BBE\u5907\u3001\u5DE5\u4E1A\u4E92\u8054\u7F51\u3002",
      products: [
        "3C\u7535\u5B50\u4EA7\u54C1",
        "\u624B\u673A\u96F6\u4EF6"
      ]
    },
    {
      code: "601166.SH",
      name: "\u5174\u4E1A\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C"
      ],
      mainBusiness: "\u4F01\u4E1A\u91D1\u878D\u4E1A\u52A1,\u96F6\u552E\u91D1\u878D\u4E1A\u52A1,\u540C\u4E1A\u548C\u91D1\u878D\u5E02\u573A\u4E1A\u52A1,\u91D1\u878D\u79D1\u6280",
      products: [
        "\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C"
      ]
    },
    {
      code: "601168.SH",
      name: "\u897F\u90E8\u77FF\u4E1A",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u57FA\u672C\u91D1\u5C5E-\u94DC",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u57FA\u672C\u91D1\u5C5E",
        "\u94DC"
      ],
      mainBusiness: "\u516C\u53F8\u5750\u62E5\u94DC\u3001\u94C5\u950C\u3001\u94C1\u7B49\u4E30\u5BCC\u77FF\u4EA7\u8D44\u6E90,\u4E3B\u8425\u4E1A\u52A1\u6DB5\u76D6\u94DC\u3001\u94C5\u3001\u950C\u3001\u94BC\u3001\u954D\u3001\u94C1\u3001\u9492\u7B49\u91D1\u5C5E\u7684\u91C7\u9009\u3001\u51B6\u70BC\u4E0E\u8D38\u6613,\u540C\u65F6\u5F00\u5C55\u9EC4\u91D1\u3001\u767D\u94F6\u7B49\u7A00\u6709\u91D1\u5C5E\u53CA\u975E\u91D1\u5C5E\u4EA7\u54C1\u7684\u751F\u4EA7\u548C\u8D38\u6613\u3002\u4F9D\u6258\u6280\u672F\u521B\u65B0\u4E0E\u6539\u9769\u53D1\u5C55,\u516C\u53F8\u5EFA\u7ACB\u4E86\u7A33\u5B9A\u7684\u77FF\u5C71\u8FD0\u8425\u4F53\u7CFB,\u5F62\u6210\u4E86\u4ECE\u77FF\u5C71\u91C7\u9009\u3001\u6709\u8272\u51B6\u70BC\u5230\u91D1\u878D\u8D38\u6613\u3001\u76D0\u6E56\u5316\u5DE5\u7B49\u591A\u9886\u57DF\u534F\u540C\u53D1\u5C55\u7684\u4EA7\u4E1A\u94FE\u5E03\u5C40,\u662F\u4E2D\u56FD\u897F\u90E8\u5730\u533A\u91CD\u8981\u7684\u77FF\u4E1A\u4F01\u4E1A",
      products: [
        "\u6709\u8272\u91D1\u5C5E\u91C7\u9009\u51B6",
        "\u94DC"
      ]
    },
    {
      code: "601208.SH",
      name: "\u4E1C\u6750\u79D1\u6280",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u65B0\u6750\u6599-\u5316\u5B66\u65B0\u6750\u6599",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u5B66\u65B0\u6750\u6599",
        "\u5316\u5B66\u65B0\u6750\u6599"
      ],
      mainBusiness: "\u5316\u5DE5\u65B0\u6750\u6599\u7684\u7814\u53D1\u3001\u5236\u9020\u548C\u9500\u552E,\u4EE5\u65B0\u578B\u7EDD\u7F18\u6750\u6599\u4E3A\u57FA\u7840,\u91CD\u70B9\u53D1\u5C55\u5149\u5B66\u819C\u6750\u6599\u3001\u7535\u5B50\u6750\u6599\u3001\u73AF\u4FDD\u963B\u71C3\u6750\u6599\u7B49\u7CFB\u5217\u4EA7\u54C1",
      products: [
        "\u7535\u5B50",
        "\u7535\u5B50\u7EA7\u73AF\u6C27\u6811\u8102\u3001\u7535\u5DE5\u7EA7\u805A\u916F\u8584\u819C\u3001\u7535\u5DE5\u7EA7\u805A\u916F\u8584\u819C\u3001\u7535\u5DE5\u819C\u3001\u8010\u706B\u6750\u6599"
      ]
    },
    {
      code: "601211.SH",
      name: "\u56FD\u6CF0\u6D77\u901A",
      availability: "available",
      industry: "\u91D1\u878D-\u975E\u94F6\u884C\u91D1\u878D-\u8BC1\u5238",
      industryLevels: [
        "\u91D1\u878D",
        "\u975E\u94F6\u884C\u91D1\u878D",
        "\u8BC1\u5238"
      ],
      mainBusiness: "\u8D22\u5BCC\u7BA1\u7406\u4E1A\u52A1,\u6295\u884C\u4E1A\u52A1,\u673A\u6784\u4E0E\u4EA4\u6613\u4E1A\u52A1,\u6295\u8D44\u7BA1\u7406\u4E1A\u52A1,\u878D\u8D44\u79DF\u8D41\u4E1A\u52A1",
      products: [
        "\u673A\u6784\u91D1\u878D",
        "\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238\u3001\u8BC1\u5238"
      ]
    },
    {
      code: "601225.SH",
      name: "\u9655\u897F\u7164\u4E1A",
      availability: "available",
      industry: "\u5316\u77F3\u80FD\u6E90-\u7164\u70AD-\u7164\u70AD\u5F00\u91C7\u6D17\u9009",
      industryLevels: [
        "\u5316\u77F3\u80FD\u6E90",
        "\u7164\u70AD",
        "\u7164\u70AD\u5F00\u91C7\u6D17\u9009"
      ],
      mainBusiness: "\u7164\u70AD\u3001\u7535\u529B\u7684\u751F\u4EA7\u548C\u9500\u552E\u4EE5\u53CA\u751F\u4EA7\u670D\u52A1\u7B49\u4E1A\u52A1,\u7164\u70AD\u4EA7\u54C1\u4E3B\u8981\u7528\u4E8E\u7535\u529B\u3001\u5316\u5DE5\u53CA\u51B6\u91D1\u7B49\u884C\u4E1A",
      products: [
        "\u81EA\u4EA7\u7164",
        "\u52A8\u529B\u7164\u3001\u7164\u70AD\u8D38\u6613\u3001\u706B\u529B\u53D1\u7535\u3001\u94C1\u8DEF\u8D27\u8FD0"
      ]
    },
    {
      code: "601229.SH",
      name: "\u4E0A\u6D77\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C"
      ],
      mainBusiness: "\u4ECE\u4E8B\u516C\u53F8\u548C\u4E2A\u4EBA\u91D1\u878D\u4E1A\u52A1\u3001\u8D44\u91D1\u4E1A\u52A1\u3001\u6295\u8D44\u94F6\u884C\u4E1A\u52A1,\u5E76\u63D0\u4F9B\u8D44\u4EA7\u7BA1\u7406\u53CA\u5176\u4ED6\u91D1\u878D\u670D\u52A1",
      products: [
        "\u6279\u53D1\u91D1\u878D\u4E1A\u52A1",
        "\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C"
      ]
    },
    {
      code: "601233.SH",
      name: "\u6850\u6606\u80A1\u4EFD",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102-\u6DA4\u7EB6",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102",
        "\u6DA4\u7EB6"
      ],
      mainBusiness: "\u5404\u7C7B\u6C11\u7528\u6DA4\u7EB6\u957F\u4E1D\u3001\u77ED\u7EA4\u3001\u576F\u5E03\u7684\u751F\u4EA7\u3001\u9500\u552E,\u4EE5\u53CA\u6DA4\u7EB6\u957F\u4E1D\u4E3B\u8981\u539F\u6599PTA(\u7CBE\u5BF9\u82EF\u4E8C\u7532\u9178)\u3001MEG(\u4E59\u4E8C\u9187)\u7684\u751F\u4EA7",
      products: [
        "\u6DA4\u7EB6\u9884\u53D6\u5411\u4E1D",
        "\u6DA4\u7EB6\u9884\u53D6\u5411\u4E1D\u3001\u6DA4\u7EB6\u7275\u4F38\u4E1D\u3001\u6DA4\u7EB6\u52A0\u5F39\u4E1D\u3001\u7CBE\u5BF9\u82EF\u4E8C\u7532\u9178\u3001PET\u5207\u7247\u3001\u7EBA\u7EC7\u539F\u6599\u3001\u4E59\u4E8C\u9187"
      ]
    },
    {
      code: "601288.SH",
      name: "\u519C\u4E1A\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u56FD\u6709\u94F6\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u56FD\u6709\u94F6\u884C"
      ],
      mainBusiness: "\u5438\u6536\u516C\u4F17\u5B58\u6B3E;\u53D1\u653E\u77ED\u671F\u3001\u4E2D\u671F\u548C\u957F\u671F\u8D37\u6B3E;\u529E\u7406\u56FD\u5185\u5916\u7ED3\u7B97;\u529E\u7406\u7968\u636E\u627F\u5151\u4E0E\u8D34\u73B0;\u53D1\u884C\u91D1\u878D\u503A\u5238;\u4EE3\u7406\u53D1\u884C\u3001\u4EE3\u7406\u5151\u4ED8\u3001\u627F\u9500\u653F\u5E9C\u503A\u5238;\u4E70\u5356\u653F\u5E9C\u503A\u5238\u3001\u91D1\u878D\u503A\u5238;\u4ECE\u4E8B\u540C\u4E1A\u62C6\u501F;\u4E70\u5356\u3001\u4EE3\u7406\u4E70\u5356\u5916\u6C47;\u4ECE\u4E8B\u94F6\u884C\u5361\u4E1A\u52A1;\u63D0\u4F9B\u4FE1\u7528\u8BC1\u670D\u52A1\u53CA\u62C5\u4FDD;\u4EE3\u7406\u6536\u4ED8\u6B3E\u9879\u4E1A\u52A1;\u63D0\u4F9B\u4FDD\u7BA1\u7BB1\u670D\u52A1;\u7ECF\u8425\u7ED3\u6C47\u3001\u552E\u6C47\u4E1A\u52A1;\u7ECF\u56FD\u52A1\u9662\u94F6\u884C\u4E1A\u76D1\u7763\u7BA1\u7406\u673A\u6784\u6279\u51C6\u7684\u5176\u4ED6\u4E1A\u52A1\u53CA\u5883\u5916\u673A\u6784\u6240\u5728\u6709\u5173\u76D1\u7BA1\u673A\u6784\u6240\u6279\u51C6\u7ECF\u8425\u7684\u4E1A\u52A1\u3002",
      products: [
        "\u4E2A\u4EBA\u94F6\u884C\u4E1A\u52A1",
        "\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C"
      ]
    },
    {
      code: "601318.SH",
      name: "\u4E2D\u56FD\u5E73\u5B89",
      availability: "available",
      industry: "\u91D1\u878D-\u975E\u94F6\u884C\u91D1\u878D-\u4FDD\u9669",
      industryLevels: [
        "\u91D1\u878D",
        "\u975E\u94F6\u884C\u91D1\u878D",
        "\u4FDD\u9669"
      ],
      mainBusiness: "\u4ECE\u4E8B\u91D1\u878D\u4E1A,\u63D0\u4F9B\u591A\u5143\u5316\u7684\u91D1\u878D\u4EA7\u54C1\u53CA\u670D\u52A1",
      products: [
        "\u5BFF\u9669\u53CA\u5065\u5EB7\u9669",
        "\u8D44\u4EA7\u7BA1\u7406\u3001\u8D44\u4EA7\u7BA1\u7406\u3001\u8D44\u4EA7\u7BA1\u7406\u3001\u8D44\u4EA7\u7BA1\u7406\u3001\u8D44\u4EA7\u7BA1\u7406\u3001\u8D44\u4EA7\u7BA1\u7406\u3001\u8D44\u4EA7\u7BA1\u7406\u3001\u8D44\u4EA7\u7BA1\u7406\u3001\u8D44\u4EA7\u7BA1\u7406"
      ]
    },
    {
      code: "601328.SH",
      name: "\u4EA4\u901A\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u56FD\u6709\u94F6\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u56FD\u6709\u94F6\u884C"
      ],
      mainBusiness: "\u94F6\u884C\u548C\u76F8\u5173\u91D1\u878D\u4E1A\u52A1,\u5305\u62EC\u516C\u53F8\u91D1\u878D\u4E1A\u52A1\u3001\u4E2A\u4EBA\u91D1\u878D\u4E1A\u52A1\u3001\u8D44\u91D1\u4E1A\u52A1\u548C\u5176\u4ED6\u7C7B\u522B\u4E1A\u52A1\u3002\u516C\u53F8\u91D1\u878D\u4E1A\u52A1\u4E3B\u8981\u5305\u62EC\u516C\u53F8\u8D37\u6B3E\u3001\u7968\u636E\u3001\u8D38\u6613\u878D\u8D44\u3001\u516C\u53F8\u5B58\u6B3E\u548C\u6C47\u6B3E\u3002\u4E2A\u4EBA\u91D1\u878D\u4E1A\u52A1\u4E3B\u8981\u5305\u62EC\u4E2A\u4EBA\u8D37\u6B3E\u3001\u96F6\u552E\u5B58\u6B3E\u3001\u4FE1\u7528\u5361\u548C\u6C47\u6B3E\u3002\u8D44\u91D1\u4E1A\u52A1\u4E3B\u8981\u5305\u62EC\u8D27\u5E01\u5E02\u573A\u8D44\u91D1\u62C6\u501F\u548C\u4E70\u5165\u3001\u6295\u8D44\u7C7B\u8BC1\u5238\u4EE5\u53CA\u6839\u636E\u5356\u51FA\u56DE\u8D2D\u534F\u8BAE\u552E\u51FA\u8BC1\u5238\u3002\u201C\u5176\u4ED6\u4E1A\u52A1\u201D\u4E3B\u8981\u5305\u62EC\u4E0D\u80FD\u5206\u7C7B\u4E3A\u4E0A\u8FF0\u4E1A\u52A1\u5206\u90E8\u7684\u5176\u4ED6\u9879\u76EE\u3002",
      products: [
        "\u516C\u53F8\u91D1\u878D\u4E1A\u52A1",
        "\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C"
      ]
    },
    {
      code: "601336.SH",
      name: "\u65B0\u534E\u4FDD\u9669",
      availability: "available",
      industry: "\u91D1\u878D-\u975E\u94F6\u884C\u91D1\u878D-\u4FDD\u9669",
      industryLevels: [
        "\u91D1\u878D",
        "\u975E\u94F6\u884C\u91D1\u878D",
        "\u4FDD\u9669"
      ],
      mainBusiness: "\u957F\u671F\u5BFF\u9669\u3001\u91CD\u5927\u75BE\u75C5\u4FDD\u9669\u3001\u5E74\u91D1\u4FDD\u9669\u3001\u77ED\u671F\u610F\u5916\u53CA\u5065\u5EB7\u4FDD\u9669",
      products: [
        "\u4F20\u7EDF\u578B\u4FDD\u9669",
        "\u5065\u5EB7\u4FDD\u9669\u3001\u5206\u7EA2\u9669\u3001\u4EBA\u5BFF\u4FDD\u9669\u3001\u4EBA\u5BFF\u4FDD\u9669\u3001\u4EBA\u5BFF\u4FDD\u9669\u3001\u4EBA\u5BFF\u4FDD\u9669\u3001\u4EBA\u5BFF\u4FDD\u9669\u3001\u4EBA\u5BFF\u4FDD\u9669"
      ]
    },
    {
      code: "601377.SH",
      name: "\u5174\u4E1A\u8BC1\u5238",
      availability: "available",
      industry: "\u91D1\u878D-\u975E\u94F6\u884C\u91D1\u878D-\u8BC1\u5238",
      industryLevels: [
        "\u91D1\u878D",
        "\u975E\u94F6\u884C\u91D1\u878D",
        "\u8BC1\u5238"
      ],
      mainBusiness: "\u8D22\u5BCC\u7BA1\u7406\u4E1A\u52A1,\u673A\u6784\u670D\u52A1\u4E1A\u52A1,\u81EA\u8425\u6295\u8D44\u4E1A\u52A1,\u6D77\u5916\u4E1A\u52A1",
      products: [
        "\u8D44\u4EA7\u7BA1\u7406\u4E1A\u52A1",
        "\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u5238\u5546\u81EA\u8425\u4E1A\u52A1\u3001\u59D4\u6258\u8D44\u4EA7\u7BA1\u7406\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u6295\u8D44\u54A8\u8BE2\u4E1A\u52A1\u3001\u8BC1\u5238\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1"
      ]
    },
    {
      code: "601398.SH",
      name: "\u5DE5\u5546\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u56FD\u6709\u94F6\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u56FD\u6709\u94F6\u884C"
      ],
      mainBusiness: "\u63D0\u4F9B\u94F6\u884C\u53CA\u76F8\u5173\u91D1\u878D\u670D\u52A1\u3002",
      products: [
        "\u516C\u53F8\u91D1\u878D\u4E1A\u52A1",
        "\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C"
      ]
    },
    {
      code: "601600.SH",
      name: "\u4E2D\u56FD\u94DD\u4E1A",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u57FA\u672C\u91D1\u5C5E-\u94DD",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u57FA\u672C\u91D1\u5C5E",
        "\u94DD"
      ],
      mainBusiness: "\u94DD\u571F\u77FF\u3001\u7164\u70AD\u7B49\u8D44\u6E90\u7684\u52D8\u63A2\u5F00\u91C7,\u6C27\u5316\u94DD\u3001\u539F\u94DD\u3001\u94DD\u5408\u91D1\u53CA\u70AD\u7D20\u4EA7\u54C1\u7684\u751F\u4EA7\u3001\u9500\u552E\u3001\u6280\u672F\u7814\u53D1,\u56FD\u9645\u8D38\u6613,\u7269\u6D41\u4EA7\u4E1A,\u706B\u529B\u53CA\u65B0\u80FD\u6E90\u53D1\u7535\u7B49",
      products: [
        "\u539F\u94DD",
        "\u539F\u94DD\u3001\u5E7F\u544A\u8425\u9500\u3001\u6C27\u5316\u94DD\u3001\u706B\u529B\u53D1\u7535"
      ]
    },
    {
      code: "601601.SH",
      name: "\u4E2D\u56FD\u592A\u4FDD",
      availability: "available",
      industry: "\u91D1\u878D-\u975E\u94F6\u884C\u91D1\u878D-\u4FDD\u9669",
      industryLevels: [
        "\u91D1\u878D",
        "\u975E\u94F6\u884C\u91D1\u878D",
        "\u4FDD\u9669"
      ],
      mainBusiness: "\u516C\u53F8\u901A\u8FC7\u65D7\u4E0B\u5B50\u516C\u53F8\u63D0\u4F9B\u5404\u7C7B\u98CE\u9669\u4FDD\u969C\u3001\u8D22\u5BCC\u89C4\u5212\u4EE5\u53CA\u8D44\u4EA7\u7BA1\u7406\u7B49\u4EA7\u54C1\u548C\u670D\u52A1\u3002\u516C\u53F8\u4E3B\u8981\u901A\u8FC7\u592A\u4FDD\u5BFF\u9669\u4E3A\u5BA2\u6237\u63D0\u4F9B\u4EBA\u8EAB\u4FDD\u9669\u4EA7\u54C1\u548C\u670D\u52A1;\u901A\u8FC7\u592A\u4FDD\u4EA7\u9669\u3001\u592A\u5E73\u6D0B\u5B89\u4FE1\u519C\u9669\u4E3A\u5BA2\u6237\u63D0\u4F9B\u8D22\u4EA7\u4FDD\u9669\u4EA7\u54C1\u548C\u670D\u52A1;\u901A\u8FC7\u592A\u5E73\u6D0B\u5065\u5EB7\u9669\u4E3A\u5BA2\u6237\u63D0\u4F9B\u5065\u5EB7\u9669\u4EA7\u54C1\u53CA\u5065\u5EB7\u7BA1\u7406\u670D\u52A1;\u901A\u8FC7\u592A\u4FDD\u8D44\u4EA7\u5F00\u5C55\u4FDD\u9669\u8D44\u91D1\u8FD0\u7528\u4EE5\u53CA\u7B2C\u4E09\u65B9\u8D44\u4EA7\u7BA1\u7406\u4E1A\u52A1;\u901A\u8FC7\u957F\u6C5F\u517B\u8001\u5F00\u5C55\u517B\u8001\u91D1\u878D\u670D\u52A1\u53CA\u76F8\u5173\u8D44\u4EA7\u7BA1\u7406\u4E1A\u52A1;\u901A\u8FC7\u592A\u4FDD\u8D44\u672C\u5F00\u5C55\u79C1\u52DF\u57FA\u91D1\u7BA1\u7406\u4E1A\u52A1\u53CA\u76F8\u5173\u54A8\u8BE2\u670D\u52A1;\u901A\u8FC7\u56FD\u8054\u5B89\u57FA\u91D1\u5F00\u5C55\u516C\u52DF\u57FA\u91D1\u7BA1\u7406\u4E1A\u52A1;\u901A\u8FC7\u592A\u4FDD\u79D1\u6280\u63D0\u4F9B\u5E02\u573A\u5316\u79D1\u6280\u8D4B\u80FD\u652F\u6301\u548C\u670D\u52A1",
      products: [
        "\u4EBA\u5BFF\u4FDD\u9669",
        "\u591A\u5143\u5316\u4FDD\u9669\u3001\u4EBA\u5BFF\u4E0E\u5065\u5EB7\u4FDD\u9669\u3001\u8D22\u4EA7\u4FDD\u9669\u3001\u591A\u5143\u5316\u4FDD\u9669\u3001\u591A\u5143\u5316\u4FDD\u9669\u3001\u591A\u5143\u5316\u4FDD\u9669\u3001\u8D44\u4EA7\u7BA1\u7406\u3001\u591A\u5143\u5316\u4FDD\u9669\u3001\u591A\u5143\u5316\u4FDD\u9669\u3001\u591A\u5143\u5316\u4FDD\u9669"
      ]
    },
    {
      code: "601628.SH",
      name: "\u4E2D\u56FD\u4EBA\u5BFF",
      availability: "available",
      industry: "\u91D1\u878D-\u975E\u94F6\u884C\u91D1\u878D-\u4FDD\u9669",
      industryLevels: [
        "\u91D1\u878D",
        "\u975E\u94F6\u884C\u91D1\u878D",
        "\u4FDD\u9669"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u4EBA\u5BFF\u4FDD\u9669\u3001\u5065\u5EB7\u4FDD\u9669\u3001\u610F\u5916\u4F24\u5BB3\u4FDD\u9669\u7B49\u5404\u7C7B\u4EBA\u8EAB\u4FDD\u9669\u4E1A\u52A1;\u4EBA\u8EAB\u4FDD\u9669\u7684\u518D\u4FDD\u9669\u4E1A\u52A1;\u56FD\u5BB6\u6CD5\u5F8B\u3001\u6CD5\u89C4\u5141\u8BB8\u6216\u56FD\u52A1\u9662\u6279\u51C6\u7684\u8D44\u91D1\u8FD0\u7528\u4E1A\u52A1;\u5404\u7C7B\u4EBA\u8EAB\u4FDD\u9669\u670D\u52A1\u3001\u54A8\u8BE2\u548C\u4EE3\u7406\u4E1A\u52A1;\u8BC1\u5238\u6295\u8D44\u57FA\u91D1\u9500\u552E\u4E1A\u52A1;\u56FD\u5BB6\u4FDD\u9669\u76D1\u7763\u7BA1\u7406\u90E8\u95E8\u6279\u51C6\u7684\u5176\u4ED6\u4E1A\u52A1\u3002",
      products: [
        "\u5BFF\u9669\u4E1A\u52A1",
        "\u4EBA\u5BFF\u4FDD\u9669\u3001\u4EBA\u8EAB\u4FDD\u9669"
      ]
    },
    {
      code: "601665.SH",
      name: "\u9F50\u9C81\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u80A1\u4EFD\u5236\u4E0E\u57CE\u5546\u884C"
      ],
      mainBusiness: "\u516C\u53F8\u94F6\u884C\u4E1A\u52A1\u3001\u96F6\u552E\u94F6\u884C\u4E1A\u52A1\u3001\u666E\u60E0\u91D1\u878D\u4E1A\u52A1\u3001\u53BF\u57DF\u91D1\u878D\u4E1A\u52A1\u3001\u91D1\u878D\u5E02\u573A\u4E1A\u52A1\u3001\u8D44\u4EA7\u7BA1\u7406\u4E1A\u52A1\u3001\u4E92\u8054\u7F51\u91D1\u878D\u4E1A\u52A1",
      products: [
        "\u516C\u53F8\u94F6\u884C\u4E1A\u52A1",
        "\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C\u3001\u533A\u57DF\u6027\u94F6\u884C"
      ]
    },
    {
      code: "601668.SH",
      name: "\u4E2D\u56FD\u5EFA\u7B51",
      availability: "available",
      industry: "\u5EFA\u7B51-\u5EFA\u7B51\u65BD\u5DE5-\u623F\u5C4B\u5EFA\u7B51",
      industryLevels: [
        "\u5EFA\u7B51",
        "\u5EFA\u7B51\u65BD\u5DE5",
        "\u623F\u5C4B\u5EFA\u7B51"
      ],
      mainBusiness: "\u4E3B\u8981\u6295\u8D44\u65B9\u5411\u4E3A\u623F\u5730\u4EA7\u5F00\u53D1\u3001\u878D\u6295\u8D44\u5EFA\u9020\u3001\u57CE\u9547\u7EFC\u5408\u5EFA\u8BBE\u7B49\u9886\u57DF\u3002\u516C\u53F8\u5F3A\u5316\u5185\u90E8\u8D44\u6E90\u6574\u5408\u4E0E\u4E1A\u52A1\u534F\u540C,\u6253\u9020\u201C\u89C4\u5212\u8BBE\u8BA1\u3001\u6295\u8D44\u5F00\u53D1\u3001\u57FA\u7840\u8BBE\u65BD\u5EFA\u8BBE\u3001\u623F\u5C4B\u5EFA\u7B51\u5DE5\u7A0B\u201D\u201C\u56DB\u4F4D\u4E00\u4F53\u201D\u7684\u5546\u4E1A\u6A21\u5F0F,\u4E3A\u57CE\u5E02\u5EFA\u8BBE\u63D0\u4F9B\u5168\u9886\u57DF\u3001\u5168\u8FC7\u7A0B\u3001\u5168\u8981\u7D20\u7684\u4E00\u63FD\u5B50\u670D\u52A1",
      products: [
        "\u623F\u5C4B\u5EFA\u7B51\u5DE5\u7A0B",
        "\u623F\u5C4B\u5EFA\u8BBE\u3001\u57FA\u7840\u5EFA\u8BBE\u3001\u5546\u54C1\u623F\u5F00\u53D1\u3001\u5EFA\u7B51\u5DE5\u7A0B\u52D8\u5BDF"
      ]
    },
    {
      code: "601688.SH",
      name: "\u534E\u6CF0\u8BC1\u5238",
      availability: "available",
      industry: "\u91D1\u878D-\u975E\u94F6\u884C\u91D1\u878D-\u8BC1\u5238",
      industryLevels: [
        "\u91D1\u878D",
        "\u975E\u94F6\u884C\u91D1\u878D",
        "\u8BC1\u5238"
      ],
      mainBusiness: "\u8D22\u5BCC\u7BA1\u7406\u4E1A\u52A1\u3001\u673A\u6784\u670D\u52A1\u4E1A\u52A1\u3001\u6295\u8D44\u7BA1\u7406\u4E1A\u52A1\u548C\u56FD\u9645\u4E1A\u52A1",
      products: [
        "\u8D22\u5BCC\u7BA1\u7406",
        "\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1\u3001\u7ECF\u7EAA\u4E1A\u52A1"
      ]
    },
    {
      code: "601689.SH",
      name: "\u62D3\u666E\u96C6\u56E2",
      availability: "available",
      industry: "\u4EA4\u8FD0\u8BBE\u5907-\u6C7D\u8F66-\u6C7D\u8F66\u96F6\u90E8\u4EF6",
      industryLevels: [
        "\u4EA4\u8FD0\u8BBE\u5907",
        "\u6C7D\u8F66",
        "\u6C7D\u8F66\u96F6\u90E8\u4EF6"
      ],
      mainBusiness: "\u6C7D\u8F66\u96F6\u90E8\u4EF6\u7684\u7814\u53D1\u3001\u751F\u4EA7\u53CA\u9500\u552E",
      products: [
        "\u5E95\u76D8\u7CFB\u7EDF",
        "\u6C7D\u8F66\u5185\u9970\u4EF6\u3001\u5176\u4ED6\u6C7D\u8F66\u5E95\u76D8\u96F6\u90E8\u4EF6\u3001\u6C7D\u8F66\u6A61\u80F6\u51CF\u9707\u5236\u54C1\u3001\u6C7D\u8F66\u7535\u5B50\u4EA7\u54C1\u3001\u6C7D\u8F66\u96F6\u4EF6\u4E0E\u8BBE\u5907\u3001\u673A\u5668\u4EBA\u914D\u4EF6"
      ]
    },
    {
      code: "601699.SH",
      name: "\u6F5E\u5B89\u73AF\u80FD",
      availability: "available",
      industry: "\u5316\u77F3\u80FD\u6E90-\u7164\u70AD-\u7164\u70AD\u5F00\u91C7\u6D17\u9009",
      industryLevels: [
        "\u5316\u77F3\u80FD\u6E90",
        "\u7164\u70AD",
        "\u7164\u70AD\u5F00\u91C7\u6D17\u9009"
      ],
      mainBusiness: "\u539F\u7164\u5F00\u91C7\u3001\u7164\u70AD\u6D17\u9009\u3001\u7164\u7126\u51B6\u70BC;\u6D01\u51C0\u7164\u6280\u672F\u7684\u5F00\u53D1\u4E0E\u5229\u7528;\u7164\u5C42\u6C14\u5F00\u53D1;\u7164\u70AD\u7684\u7EFC\u5408\u5229\u7528\u3001\u5730\u8D28\u52D8\u63A2\u7B49",
      products: [
        "\u7164\u70AD",
        "\u7164\u70AD\u3001\u7126\u70AD"
      ]
    },
    {
      code: "601816.SH",
      name: "\u4EAC\u6CAA\u9AD8\u94C1",
      availability: "available",
      industry: "\u4EA4\u901A\u8FD0\u8F93-\u516C\u8DEF\u94C1\u8DEF-\u94C1\u8DEF\u8FD0\u8F93",
      industryLevels: [
        "\u4EA4\u901A\u8FD0\u8F93",
        "\u516C\u8DEF\u94C1\u8DEF",
        "\u94C1\u8DEF\u8FD0\u8F93"
      ],
      mainBusiness: "\u9AD8\u94C1\u65C5\u5BA2\u8FD0\u8F93,\u5177\u4F53\u4E3B\u8981\u5305\u62EC:(1)\u4E3A\u4E58\u5750\u62C5\u5F53\u5217\u8F66\u7684\u65C5\u5BA2\u63D0\u4F9B\u9AD8\u94C1\u8FD0\u8F93\u670D\u52A1\u5E76\u6536\u53D6\u7968\u4EF7\u6B3E;(2)\u5176\u4ED6\u94C1\u8DEF\u8FD0\u8F93\u4F01\u4E1A\u62C5\u5F53\u7684\u5217\u8F66\u5728\u4EAC\u6CAA\u9AD8\u901F\u94C1\u8DEF\u4E0A\u8FD0\u884C\u65F6,\u5411\u5176\u63D0\u4F9B\u7EBF\u8DEF\u4F7F\u7528\u3001\u63A5\u89E6\u7F51\u4F7F\u7528\u7B49\u670D\u52A1\u5E76\u6536\u53D6\u76F8\u5E94\u8D39\u7528\u7B49\u3002",
      products: [
        "\u5176\u4ED6\u4E1A\u52A1",
        "\u94C1\u8DEF\u8FD0\u8425\u3001\u94C1\u8DEF\u5BA2\u8FD0"
      ]
    },
    {
      code: "601857.SH",
      name: "\u4E2D\u56FD\u77F3\u6CB9",
      availability: "available",
      industry: "\u5316\u77F3\u80FD\u6E90-\u77F3\u6CB9\u5929\u7136\u6C14-\u77F3\u6CB9\u5929\u7136\u6C14\u5F00\u91C7",
      industryLevels: [
        "\u5316\u77F3\u80FD\u6E90",
        "\u77F3\u6CB9\u5929\u7136\u6C14",
        "\u77F3\u6CB9\u5929\u7136\u6C14\u5F00\u91C7"
      ],
      mainBusiness: "\u539F\u6CB9\u53CA\u5929\u7136\u6C14\u7684\u52D8\u63A2\u3001\u5F00\u53D1\u3001\u751F\u4EA7\u3001\u8F93\u9001\u548C\u9500\u552E\u53CA\u65B0\u80FD\u6E90\u4E1A\u52A1;\u539F\u6CB9\u53CA\u77F3\u6CB9\u4EA7\u54C1\u7684\u70BC\u5236,\u57FA\u672C\u53CA\u884D\u751F\u5316\u5DE5\u4EA7\u54C1\u3001\u5176\u4ED6\u5316\u5DE5\u4EA7\u54C1\u7684\u751F\u4EA7\u548C\u9500\u552E\u53CA\u65B0\u6750\u6599\u4E1A\u52A1;\u70BC\u6CB9\u4EA7\u54C1\u548C\u975E\u6CB9\u54C1\u7684\u9500\u552E\u4EE5\u53CA\u8D38\u6613\u4E1A\u52A1;\u5929\u7136\u6C14\u7684\u8F93\u9001\u53CA\u9500\u552E\u4E1A\u52A1",
      products: [
        "\u52D8\u63A2\u4E0E\u751F\u4EA7",
        "\u70BC\u6CB9\u4EA7\u54C1\u3001\u5929\u7136\u6C14\u3001\u539F\u6CB9\u3001\u77F3\u5316\u4EA7\u54C1\u3001\u65E5\u7528\u54C1\u7ECF\u9500\u3001\u6CB9\u6C14\u7BA1\u9053\u8FD0\u8F93"
      ]
    },
    {
      code: "601869.SH",
      name: "\u957F\u98DE\u5149\u7EA4",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8BBE\u5907-\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u901A\u4FE1\u8BBE\u5907",
        "\u901A\u4FE1\u4F20\u8F93\u8BBE\u5907"
      ],
      mainBusiness: "\u516C\u53F8\u4E13\u6CE8\u4E8E\u901A\u4FE1\u884C\u4E1A,\u662F\u5168\u7403\u9886\u5148\u7684\u5149\u7EA4\u9884\u5236\u68D2\u3001\u5149\u7EA4\u3001\u5149\u7F06\u4EE5\u53CA\u6570\u636E\u901A\u4FE1\u76F8\u5173\u4EA7\u54C1\u7684\u7814\u53D1\u521B\u65B0\u4E0E\u751F\u4EA7\u5236\u9020\u4F01\u4E1A,\u5E76\u5F62\u6210\u4E86\u68D2\u7EA4\u7F06\u3001\u7EFC\u5408\u5E03\u7EBF\u3001\u5149\u6A21\u5757\u548C\u901A\u4FE1\u7F51\u7EDC\u5DE5\u7A0B\u7B49\u5149\u901A\u4FE1\u76F8\u5173\u4EA7\u54C1\u4E0E\u670D\u52A1\u4E00\u4F53\u5316\u7684\u5B8C\u6574\u4EA7\u4E1A\u94FE\u53CA\u591A\u5143\u5316\u548C\u56FD\u9645\u5316\u7684\u4E1A\u52A1\u6A21\u5F0F",
      products: [
        "\u5149\u4F20\u8F93",
        "\u5149\u7F06\u3001\u5149\u7EA4"
      ]
    },
    {
      code: "601872.SH",
      name: "\u62DB\u5546\u8F6E\u8239",
      availability: "available",
      industry: "\u4EA4\u901A\u8FD0\u8F93-\u6E2F\u53E3\u822A\u8FD0-\u822A\u8FD0",
      industryLevels: [
        "\u4EA4\u901A\u8FD0\u8F93",
        "\u6E2F\u53E3\u822A\u8FD0",
        "\u822A\u8FD0"
      ],
      mainBusiness: "\u56FD\u9645\u56FD\u5185\u8D27\u7269\u8FD0\u8F93,\u6CB9\u6C14(LNG)\u8FD0\u8F93,\u5E72\u6563\u8D27\u822A\u8FD0,\u5176\u4ED6\u4E1A\u52A1(\u96C6\u88C5\u7BB1\u3001\u6C7D\u8F66\u6EDA\u88C5\u8FD0\u8F93\u3001\u7279\u79CD\u8FD0\u8F93\u53CA\u822A\u8FD0\u76F8\u5173\u652F\u6301\u578B\u4E1A\u52A1)",
      products: [
        "\u6CB9\u8F6E\u8FD0\u8F93",
        "\u6CB9\u8F6E\u8FD0\u8F93\u3001\u5E72\u6563\u8D27\u8239\u8FD0\u8F93\u3001\u96C6\u88C5\u7BB1\u8239\u8FD0\u8F93\u3001\u5176\u4ED6\u8239\u8236\u8D27\u8FD0\u3001\u96C6\u88C5\u7BB1\u8239\u8FD0\u8F93\u3001\u6DB2\u5316\u6C14\u8239\u8FD0\u8F93"
      ]
    },
    {
      code: "601899.SH",
      name: "\u7D2B\u91D1\u77FF\u4E1A",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u8D35\u91D1\u5C5E-\u9EC4\u91D1",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u8D35\u91D1\u5C5E",
        "\u9EC4\u91D1"
      ],
      mainBusiness: "\u77FF\u4EA7\u8D44\u6E90\u52D8\u67E5;\u91D1\u77FF\u91C7\u9009;\u91D1\u51B6\u70BC;\u94DC\u77FF\u91C7\u9009;\u94DC\u51B6\u70BC;\u73E0\u5B9D\u9996\u9970\u3001\u77FF\u4EA7\u54C1\u7684\u9500\u552E;\u5BF9\u91C7\u77FF\u4E1A\u7684\u6295\u8D44;\u5BF9\u5916\u8D38\u6613;\u94DC\u77FF\u91D1\u77FF\u9732\u5929\u5F00\u91C7\u3001\u94DC\u77FF\u5730\u4E0B\u5F00\u91C7;\u73AF\u5883\u4FDD\u62A4\u4E13\u7528\u8BBE\u5907\u5236\u9020;\u5927\u6C14\u6C61\u67D3\u6CBB\u7406;\u6C34\u6C61\u67D3\u6CBB\u7406;\u56FA\u4F53\u5E9F\u7269\u6CBB\u7406;\u5783\u573E\u711A\u70E7\u53D1\u7535\u4E1A\u52A1\u53CA\u5371\u9669\u5E9F\u7269\u5904\u7F6E\u7B49\u3002",
      products: [
        "\u77FF\u5C71\u4EA7\u91D1",
        "\u9EC4\u91D1\u3001\u94DC\u3001\u94DC\u77FF\u3001\u91D1\u77FF\u3001\u91D1\u77FF\u3001\u7535\u89E3\u94DC\u3001\u950C\u952D\u3001\u7535\u79EF\u94DC\u3001\u950C\u77FF\u3001\u94F6\u77FF\u3001\u94C1\u7CBE\u7C89"
      ]
    },
    {
      code: "601918.SH",
      name: "\u65B0\u96C6\u80FD\u6E90",
      availability: "available",
      industry: "\u5316\u77F3\u80FD\u6E90-\u7164\u70AD-\u7164\u70AD\u5F00\u91C7\u6D17\u9009",
      industryLevels: [
        "\u5316\u77F3\u80FD\u6E90",
        "\u7164\u70AD",
        "\u7164\u70AD\u5F00\u91C7\u6D17\u9009"
      ],
      mainBusiness: "\u4EE5\u7164\u70AD\u5F00\u91C7\u3001\u7164\u70AD\u6D17\u9009\u548C\u706B\u529B\u53D1\u7535\u4E3A\u4E3B\u7684\u80FD\u6E90\u9879\u76EE,\u5BF9\u5916\u9500\u552E\u7164\u70AD\u548C\u7535\u529B",
      products: [
        "\u7164\u70AD",
        "\u7164\u70AD\u3001\u706B\u529B\u53D1\u7535"
      ]
    },
    {
      code: "601919.SH",
      name: "\u4E2D\u8FDC\u6D77\u63A7",
      availability: "available",
      industry: "\u4EA4\u901A\u8FD0\u8F93-\u6E2F\u53E3\u822A\u8FD0-\u822A\u8FD0",
      industryLevels: [
        "\u4EA4\u901A\u8FD0\u8F93",
        "\u6E2F\u53E3\u822A\u8FD0",
        "\u822A\u8FD0"
      ],
      mainBusiness: "\u56FD\u5185\u96C6\u88C5\u7BB1\u8FD0\u8F93\u670D\u52A1\u53CA\u76F8\u5173\u4E1A\u52A1\u4EE5\u53CA\u4ECE\u4E8B\u96C6\u88C5\u7BB1\u548C\u6563\u6742\u8D27\u7801\u5934\u7684\u88C5\u5378\u548C\u5806\u5B58\u4E1A\u52A1",
      products: [
        "\u96C6\u88C5\u7BB1\u822A\u8FD0\u53CA\u76F8\u5173\u4E1A\u52A1",
        "\u96C6\u88C5\u7BB1\u8239\u8FD0\u8F93\u3001\u6E2F\u53E3\u670D\u52A1"
      ]
    },
    {
      code: "601939.SH",
      name: "\u5EFA\u8BBE\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u56FD\u6709\u94F6\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u56FD\u6709\u94F6\u884C"
      ],
      mainBusiness: "\u516C\u53F8\u91D1\u878D\u4E1A\u52A1\u3001\u4E2A\u4EBA\u91D1\u878D\u4E1A\u52A1\u3001\u8D44\u91D1\u8D44\u7BA1\u4E1A\u52A1\u548C\u5305\u62EC\u5883\u5916\u4E1A\u52A1\u5728\u5185\u7684\u5176\u4ED6\u4E1A\u52A1",
      products: [
        "\u4E2A\u4EBA\u91D1\u878D\u4E1A\u52A1",
        "\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C"
      ]
    },
    {
      code: "601985.SH",
      name: "\u4E2D\u56FD\u6838\u7535",
      availability: "available",
      industry: "\u516C\u7528\u4E8B\u4E1A-\u7535\u529B-\u65B0\u80FD\u6E90\u53D1\u7535",
      industryLevels: [
        "\u516C\u7528\u4E8B\u4E1A",
        "\u7535\u529B",
        "\u65B0\u80FD\u6E90\u53D1\u7535"
      ],
      mainBusiness: "\u7535\u529B(\u5305\u62EC\u6838\u80FD\u53D1\u7535\u4E0E\u98CE\u3001\u5149\u53D1\u7535)\u9500\u552E\u4E1A\u52A1\u3001\u6838\u7535\u76F8\u5173\u6280\u672F\u670D\u52A1\u4E0E\u54A8\u8BE2\u4E1A\u52A1",
      products: [
        "\u6838\u7535",
        "\u6838\u80FD\u53D1\u7535\u3001\u5149\u4F0F\u53D1\u7535\u3001\u98CE\u529B\u53D1\u7535\u3001\u7535\u7AD9\u8FD0\u7EF4\u670D\u52A1\u3001\u54A8\u8BE2\u670D\u52A1"
      ]
    },
    {
      code: "601988.SH",
      name: "\u4E2D\u56FD\u94F6\u884C",
      availability: "available",
      industry: "\u91D1\u878D-\u94F6\u884C-\u56FD\u6709\u94F6\u884C",
      industryLevels: [
        "\u91D1\u878D",
        "\u94F6\u884C",
        "\u56FD\u6709\u94F6\u884C"
      ],
      mainBusiness: "\u4ECE\u4E8B\u5168\u9762\u7684\u516C\u53F8\u91D1\u878D\u4E1A\u52A1\u3001\u4E2A\u4EBA\u91D1\u878D\u4E1A\u52A1\u3001\u8D44\u91D1\u4E1A\u52A1\u3001\u6295\u8D44\u94F6\u884C\u4E1A\u52A1\u3001\u4FDD\u9669\u4E1A\u52A1\u548C\u5176\u4ED6\u4E1A\u52A1",
      products: [
        "\u516C\u53F8\u91D1\u878D\u4E1A\u52A1",
        "\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C\u3001\u7EFC\u5408\u6027\u94F6\u884C"
      ]
    },
    {
      code: "603019.SH",
      name: "\u4E2D\u79D1\u66D9\u5149",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u786C\u4EF6-\u4E13\u7528\u8BA1\u7B97\u673A\u8BBE\u5907",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u8BA1\u7B97\u673A\u786C\u4EF6",
        "\u4E13\u7528\u8BA1\u7B97\u673A\u8BBE\u5907"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u9AD8\u7AEF\u8BA1\u7B97\u673A\u3001\u5B58\u50A8\u3001\u5B89\u5168\u3001\u6570\u636E\u4E2D\u5FC3\u4EA7\u54C1\u7684\u7814\u53D1\u53CA\u5236\u9020,\u540C\u65F6\u5927\u529B\u53D1\u5C55\u6570\u5B57\u57FA\u7840\u8BBE\u65BD\u5EFA\u8BBE\u3001\u667A\u80FD\u8BA1\u7B97\u7B49\u4E1A\u52A1",
      products: [
        "IT\u8BBE\u5907\u4E1A\u52A1",
        "\u670D\u52A1\u5668\u3001\u8BA1\u7B97\u673A\u7F51\u7EDC\u7CFB\u7EDF\u96C6\u6210"
      ]
    },
    {
      code: "603061.SH",
      name: "\u91D1\u6D77\u901A",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u96C6\u6210\u7535\u8DEF\u6D4B\u8BD5\u5206\u9009\u673A\u7684\u7814\u53D1\u3001\u751F\u4EA7\u53CA\u9500\u552E",
      products: [
        "\u6D4B\u8BD5\u5206\u9009\u673A",
        "\u534A\u5BFC\u4F53\u6D4B\u8BD5\u8BBE\u5907"
      ]
    },
    {
      code: "603067.SH",
      name: "\u632F\u534E\u80A1\u4EFD",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u539F\u6599-\u65E0\u673A\u76D0",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u5B66\u539F\u6599",
        "\u65E0\u673A\u76D0"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u94EC\u5316\u5B66\u54C1\u3001\u7EF4\u751F\u7D20K3\u7B49\u94EC\u76D0\u8054\u4EA7\u4EA7\u54C1\u3001\u8D85\u7EC6\u6C22\u6C27\u5316\u94DD\u7B49\u94EC\u76D0\u526F\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u5236\u9020\u4E0E\u9500\u552E\u3002",
      products: [
        "\u94EC\u7684\u6C27\u5316\u7269",
        "\u65E0\u673A\u76D0\u3001\u94EC\u6C27\u5316\u7269\u3001\u91CD\u94EC\u9178\u76D0\u3001\u8D85\u7EC6\u6C22\u6C27\u5316\u94DD"
      ]
    },
    {
      code: "603083.SH",
      name: "\u5251\u6865\u79D1\u6280",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u901A\u4FE1\u8BBE\u5907-\u901A\u4FE1\u7EC8\u7AEF\u8BBE\u5907",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u901A\u4FE1\u8BBE\u5907",
        "\u901A\u4FE1\u7EC8\u7AEF\u8BBE\u5907"
      ],
      mainBusiness: "\u7535\u4FE1\u3001\u6570\u901A\u3001\u4F01\u4E1A\u7F51\u7EDC\u53CA\u5BB6\u5EAD\u7F51\u7EDC\u9886\u57DF\u7684\u7EC8\u7AEF\u8BBE\u5907(\u6DB5\u76D6\u7535\u4FE1\u5BBD\u5E26\u3001\u65E0\u7EBF\u7F51\u7EDC\u4E0E\u5C0F\u57FA\u7AD9\u3001\u8FB9\u7F18\u8BA1\u7B97\u4E0E\u5DE5\u4E1A\u4E92\u8054\u4EA7\u54C1)\u4EE5\u53CA\u9AD8\u901F\u5149\u6A21\u5757\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u5149\u6A21\u5757",
        "\u56FA\u7F51\u63A5\u5165\u8BBE\u5907\u3001\u5149\u6A21\u5757\u3001\u8FB9\u7F18\u8BA1\u7B97\u8BBE\u5907"
      ]
    },
    {
      code: "603129.SH",
      name: "\u6625\u98CE\u52A8\u529B",
      availability: "available",
      industry: "\u4EA4\u8FD0\u8BBE\u5907-\u5176\u4ED6\u4EA4\u8FD0\u8BBE\u5907-\u5176\u4ED6\u4EA4\u8FD0\u8BBE\u5907",
      industryLevels: [
        "\u4EA4\u8FD0\u8BBE\u5907",
        "\u5176\u4ED6\u4EA4\u8FD0\u8BBE\u5907",
        "\u5176\u4ED6\u4EA4\u8FD0\u8BBE\u5907"
      ],
      mainBusiness: "\u805A\u7126\u5168\u5730\u5F62\u8F66\u3001\u71C3\u6CB9\u6469\u6258\u8F66\u3001\u7535\u52A8\u4E24\u8F6E\u8F66\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u5168\u5730\u5F62\u8F66",
        "\u5168\u5730\u5F62\u8F66\u3001\u4E24\u8F6E\u6469\u6258\u8F66\u3001\u4E24\u8F6E\u6469\u6258\u8F66\u3001\u6469\u6258\u8F66\u96F6\u90E8\u4EF6"
      ]
    },
    {
      code: "603210.SH",
      name: "\u6CF0\u9E3F\u4E07\u7ACB",
      availability: "available",
      industry: "\u4EA4\u8FD0\u8BBE\u5907-\u6C7D\u8F66-\u6C7D\u8F66\u96F6\u90E8\u4EF6",
      industryLevels: [
        "\u4EA4\u8FD0\u8BBE\u5907",
        "\u6C7D\u8F66",
        "\u6C7D\u8F66\u96F6\u90E8\u4EF6"
      ],
      mainBusiness: "\u6C7D\u8F66\u7ED3\u6784\u4EF6\u3001\u529F\u80FD\u4EF6\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u7ED3\u6784\u4EF6",
        "\u7CBE\u5BC6\u7ED3\u6784\u4EF6\u3001\u6C7D\u8F66\u5185\u9970\u4EF6"
      ]
    },
    {
      code: "603256.SH",
      name: "\u5B8F\u548C\u79D1\u6280",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102-\u73BB\u7EA4",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102",
        "\u73BB\u7EA4"
      ],
      mainBusiness: "\u6781\u8584\u5E03\u3001\u8D85\u8584\u5E03\u7B49\u9AD8\u7AEFE\u73BB\u7483\u7EA4\u7EF4\u5E03\u4EE5\u53CA\u4F4E\u4ECB\u7535\u3001\u4F4E\u70ED\u81A8\u80C0\u7CFB\u6570\u7B49\u7279\u79CD\u7535\u5B50\u7EA7\u73BB\u7483\u7EA4\u7EF4\u5E03\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u7535\u5B50\u7EA7\u73BB\u7483\u7EA4\u7EF4\u5E03\u9500\u552E",
        "\u73BB\u7483\u7EA4\u7EF4\u5E03\u3001\u73BB\u7483\u7EA4\u7EF4\u5E03\u3001\u73BB\u7483\u7EA4\u7EF4\u7EB1"
      ]
    },
    {
      code: "603259.SH",
      name: "\u836F\u660E\u5EB7\u5FB7",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u5316\u5B66\u5236\u836F-\u5316\u5B66\u5236\u5242",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u5316\u5B66\u5236\u836F",
        "\u5316\u5B66\u5236\u5242"
      ],
      mainBusiness: "\u5168\u7403\u533B\u836F\u53CA\u751F\u547D\u79D1\u5B66\u884C\u4E1A\u63D0\u4F9B\u4E00\u4F53\u5316\u3001\u7AEF\u5230\u7AEF\u7684\u65B0\u836F\u7814\u53D1\u548C\u751F\u4EA7\u670D\u52A1,\u5728\u4E9A\u6D32\u3001\u6B27\u6D32\u3001\u5317\u7F8E\u7B49\u5730\u5747\u8BBE\u6709\u8FD0\u8425\u57FA\u5730\u3002\u516C\u53F8\u901A\u8FC7\u72EC\u7279\u7684\u201CCRDMO\u201D\u4E1A\u52A1\u6A21\u5F0F,\u4E0D\u65AD\u964D\u4F4E\u7814\u53D1\u95E8\u69DB,\u52A9\u529B\u5BA2\u6237\u63D0\u5347\u7814\u53D1\u6548\u7387,\u4E3A\u60A3\u8005\u5E26\u6765\u66F4\u591A\u7A81\u7834\u6027\u7684\u6CBB\u7597\u65B9\u6848,\u670D\u52A1\u8303\u56F4\u6DB5\u76D6\u5316\u5B66\u836F\u7814\u53D1\u548C\u751F\u4EA7\u3001\u751F\u7269\u5B66\u7814\u7A76\u3001\u4E34\u5E8A\u524D\u6D4B\u8BD5\u548C\u4E34\u5E8A\u7814\u53D1\u7B49\u9886\u57DF\u3002",
      products: [
        "\u5316\u5B66\u4E1A\u52A1",
        "CRO\u3001\u751F\u7269\u6280\u672F\u670D\u52A1"
      ]
    },
    {
      code: "603268.SH",
      name: "\u677E\u53D1\u80A1\u4EFD",
      availability: "available",
      industry: "\u56FD\u9632\u4E0E\u88C5\u5907-\u8239\u8236\u4E0E\u6D77\u6D0B\u88C5\u5907-\u8239\u8236\u5236\u9020",
      industryLevels: [
        "\u56FD\u9632\u4E0E\u88C5\u5907",
        "\u8239\u8236\u4E0E\u6D77\u6D0B\u88C5\u5907",
        "\u8239\u8236\u5236\u9020"
      ],
      mainBusiness: "\u8239\u8236\u53CA\u9AD8\u7AEF\u88C5\u5907\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u8239\u8236\u5EFA\u9020\u53CA\u76F8\u5173\u4EA7\u54C1",
        "\u822A\u6D77\u88C5\u5907"
      ]
    },
    {
      code: "603288.SH",
      name: "\u6D77\u5929\u5473\u4E1A",
      availability: "available",
      industry: "\u98DF\u54C1\u996E\u6599-\u98DF\u54C1-\u8C03\u5473\u54C1",
      industryLevels: [
        "\u98DF\u54C1\u996E\u6599",
        "\u98DF\u54C1",
        "\u8C03\u5473\u54C1"
      ],
      mainBusiness: "\u8C03\u5473\u54C1\u7684\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u9171\u6CB9",
        "\u9171\u6CB9\u3001\u869D\u6CB9\u3001\u8C03\u5473\u54C1\u3001\u8C03\u5473\u9171"
      ]
    },
    {
      code: "603345.SH",
      name: "\u5B89\u4E95\u98DF\u54C1",
      availability: "available",
      industry: "\u98DF\u54C1\u996E\u6599-\u98DF\u54C1-\u98DF\u54C1\u7EFC\u5408",
      industryLevels: [
        "\u98DF\u54C1\u996E\u6599",
        "\u98DF\u54C1",
        "\u98DF\u54C1\u7EFC\u5408"
      ],
      mainBusiness: "\u901F\u51BB\u8C03\u5236\u98DF\u54C1(\u4EE5\u901F\u51BB\u9C7C\u7CDC\u5236\u54C1\u3001\u901F\u51BB\u8089\u5236\u54C1\u4E3A\u4E3B)\u548C\u901F\u51BB\u9762\u7C73\u5236\u54C1\u3001\u901F\u51BB\u83DC\u80B4\u5236\u54C1\u7B49\u901F\u51BB\u98DF\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u901F\u51BB\u8C03\u5236\u98DF\u54C1\u6DAE\u70E4\u7B49\u4EA7\u54C1",
        "\u901F\u51BB\u8C03\u5236\u98DF\u54C1\u3001\u5176\u4ED6\u901F\u51BB\u98DF\u54C1\u3001\u901F\u51BB\u9762\u7C73\u5236\u54C1\u3001\u70D8\u7119\u98DF\u54C1"
      ]
    },
    {
      code: "603370.SH",
      name: "\u534E\u65B0\u7CBE\u79D1",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u91D1\u5C5E\u5236\u54C1-\u91D1\u5C5E\u5236\u54C1",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u91D1\u5C5E\u5236\u54C1",
        "\u91D1\u5C5E\u5236\u54C1"
      ],
      mainBusiness: "\u7CBE\u5BC6\u94C1\u82AF\u7684\u7814\u53D1\u3001\u5236\u9020\u4E0E\u9500\u552E,\u540C\u65F6\u914D\u5957\u63D0\u4F9B\u94C1\u82AF\u751F\u4EA7\u6240\u9700\u7684\u7CBE\u5BC6\u6A21\u5177",
      products: [
        "\u7CBE\u5BC6\u51B2\u538B\u94C1\u82AF",
        "\u7535\u673A\u94C1\u82AF\u3001\u7CBE\u5BC6\u6A21\u5177"
      ]
    },
    {
      code: "603382.SH",
      name: "\u6D77\u9633\u79D1\u6280",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102-\u5408\u6210\u6811\u8102",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5408\u6210\u7EA4\u7EF4\u53CA\u6811\u8102",
        "\u5408\u6210\u6811\u8102"
      ],
      mainBusiness: "\u516C\u53F8\u7CFB\u56FD\u5185\u4ECE\u4E8B\u5C3C\u9F996\u7CFB\u5217\u4EA7\u54C1\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u5C3C\u9F996\u5207\u7247",
        "\u9526\u7EB66\u5207\u7247\u3001\u6DA4\u7EB6\u5E18\u5B50\u5E03\u3001\u5C3C\u9F996\u5DE5\u4E1A\u4E1D"
      ]
    },
    {
      code: "603459.SH",
      name: "\u7EA2\u677F\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u516C\u53F8\u4E13\u6CE8\u4E8E\u5370\u5236\u7535\u8DEF\u677F\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "HDI\u677F",
        "\u521A\u6027\u5370\u5236\u7535\u8DEF\u677F\u3001\u521A\u6027\u5370\u5236\u7535\u8DEF\u677F\u3001\u6320\u6027\u5370\u5236\u7535\u8DEF\u677F\u3001\u521A\u6320\u7ED3\u5408\u5370\u5236\u7535\u8DEF\u677F\u3001\u5C01\u88C5\u57FA\u677F\u3001\u5370\u5236\u7535\u8DEF\u677F"
      ]
    },
    {
      code: "603678.SH",
      name: "\u706B\u70AC\u7535\u5B50",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u4ECE\u4E8B\u7535\u5B50\u5143\u5668\u4EF6\u3001\u65B0\u6750\u6599\u53CA\u76F8\u5173\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E\u3001\u68C0\u6D4B\u53CA\u670D\u52A1\u4E1A\u52A1",
      products: [
        "\u5143\u5668\u4EF6",
        "\u7535\u5B50\u5143\u5668\u4EF6\u5206\u9500\u670D\u52A1\u3001\u5FAE\u6CE2\u5668\u4EF6\u3001\u7279\u79CD\u9676\u74F7\u6750\u6599"
      ]
    },
    {
      code: "603799.SH",
      name: "\u534E\u53CB\u94B4\u4E1A",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u5176\u4ED6\u7A00\u6709\u5C0F\u91D1\u5C5E",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u7A00\u6709\u91D1\u5C5E",
        "\u5176\u4ED6\u7A00\u6709\u5C0F\u91D1\u5C5E"
      ],
      mainBusiness: "\u9502\u7535\u6750\u6599\u3001\u80FD\u6E90\u91D1\u5C5E\u3001\u80FD\u6E90\u6750\u6599\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u5236\u9020\u4E0E\u9500\u552E",
      products: [
        "\u954D\u77FF\u4EA7\u54C1",
        "\u954D\u3001\u9502\u79BB\u5B50\u7535\u6C60\u6B63\u6781\u6750\u6599\u3001\u6709\u8272\u91D1\u5C5E\u51B6\u70BC\u52A0\u5DE5\u4E2D\u95F4\u54C1\u3001\u6709\u8272\u91D1\u5C5E\u8D38\u6613\u3001\u94B4\u3001\u94DC\u3001\u4E09\u5143\u524D\u9A71\u4F53\u3001\u9502"
      ]
    },
    {
      code: "603986.SH",
      name: "\u5146\u6613\u521B\u65B0",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u5B58\u50A8\u5668\u3001\u5FAE\u63A7\u5236\u5668\u548C\u4F20\u611F\u5668\u7684\u7814\u53D1\u3001\u6280\u672F\u652F\u6301\u548C\u9500\u552E",
      products: [
        "\u5B58\u50A8\u82AF\u7247",
        "\u5B58\u50A8\u5668\u82AF\u7247\u3001MCU\u3001\u4F20\u611F\u5668\u3001\u6280\u672F\u670D\u52A1"
      ]
    },
    {
      code: "603993.SH",
      name: "\u6D1B\u9633\u94BC\u4E1A",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u57FA\u672C\u91D1\u5C5E-\u94DC",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u57FA\u672C\u91D1\u5C5E",
        "\u94DC"
      ],
      mainBusiness: "\u6709\u8272\u91D1\u5C5E\u7684\u91C7\u3001\u9009\u3001\u51B6\u7B49\u77FF\u5C71\u91C7\u6398\u53CA\u52A0\u5DE5\u4E1A\u52A1\u548C\u91D1\u5C5E\u8D38\u6613\u4E1A\u52A1",
      products: [
        "\u94DC\u94B4\u76F8\u5173\u4EA7\u54C1",
        "\u6709\u8272\u91D1\u5C5E\u8D38\u6613\u3001\u5176\u4ED6\u91D1\u5C5E\u4E0E\u91C7\u77FF"
      ]
    },
    {
      code: "605111.SH",
      name: "\u65B0\u6D01\u80FD",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u5206\u7ACB\u5668\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u5206\u7ACB\u5668\u4EF6"
      ],
      mainBusiness: "MOSFET\u3001IGBT\u7B49\u534A\u5BFC\u4F53\u529F\u7387\u5668\u4EF6\u53CA\u529F\u7387\u6A21\u5757\u7684\u7814\u53D1\u8BBE\u8BA1\u53CA\u9500\u552E",
      products: [
        "\u529F\u7387\u5668\u4EF6",
        "\u5206\u7ACB\u5668\u4EF6\u3001\u529F\u7387\u5668\u4EF6"
      ]
    },
    {
      code: "605117.SH",
      name: "\u5FB7\u4E1A\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u7535\u6E90\u8BBE\u5907-\u50A8\u80FD\u8BBE\u5907",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u7535\u6E90\u8BBE\u5907",
        "\u50A8\u80FD\u8BBE\u5907"
      ],
      mainBusiness: "\u65B0\u80FD\u6E90\u4E1A\u52A1\u3001\u73AF\u5883\u7535\u5668\u4E1A\u52A1",
      products: [
        "\u9500\u552E\u5546\u54C1",
        "\u50A8\u80FD\u53D8\u6D41\u5668\u3001\u50A8\u80FD\u7535\u6C60\u3001\u5149\u4F0F\u9006\u53D8\u5668\u3001\u5BB6\u7535\u914D\u4EF6\u3001\u9664\u6E7F\u673A\u3001\u5236\u51B7\u7A7A\u8C03\u8BBE\u5907\u3001\u9006\u53D8\u5668"
      ]
    },
    {
      code: "605358.SH",
      name: "\u7ACB\u6602\u5FAE",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u6750\u6599"
      ],
      mainBusiness: "\u4E09\u5927\u4E1A\u52A1\u677F\u5757:\u534A\u5BFC\u4F53\u7845\u7247\u3001\u534A\u5BFC\u4F53\u529F\u7387\u5668\u4EF6\u82AF\u7247\u3001\u5316\u5408\u7269\u534A\u5BFC\u4F53\u5C04\u9891\u53CA\u5149\u7535\u82AF\u7247",
      products: [
        "\u534A\u5BFC\u4F53\u7845\u7247",
        "\u7845\u7247\u3001\u529F\u7387IC\u3001\u5C04\u9891\u82AF\u7247"
      ]
    },
    {
      code: "605376.SH",
      name: "\u535A\u8FC1\u65B0\u6750",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u7A00\u6709\u91D1\u5C5E-\u5176\u4ED6\u7A00\u6709\u5C0F\u91D1\u5C5E",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u7A00\u6709\u91D1\u5C5E",
        "\u5176\u4ED6\u7A00\u6709\u5C0F\u91D1\u5C5E"
      ],
      mainBusiness: "\u4E3B\u8425\u4E1A\u52A1\u4E3A\u7535\u5B50\u4E13\u7528\u9AD8\u7AEF\u91D1\u5C5E\u7C89\u4F53\u6750\u6599\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u954D\u57FA\u4EA7\u54C1",
        "\u954D\u7C89\u3001\u94DC\u7C89\u3001\u94F6\u7C89\u3001\u5408\u91D1\u7C89\u672B"
      ]
    },
    {
      code: "605499.SH",
      name: "\u4E1C\u9E4F\u996E\u6599",
      availability: "available",
      industry: "\u98DF\u54C1\u996E\u6599-\u996E\u6599-\u8F6F\u996E\u6599",
      industryLevels: [
        "\u98DF\u54C1\u996E\u6599",
        "\u996E\u6599",
        "\u8F6F\u996E\u6599"
      ],
      mainBusiness: "\u996E\u6599\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u80FD\u91CF\u996E\u6599",
        "\u529F\u80FD\u996E\u6599\u3001\u529F\u80FD\u996E\u6599\u3001\u5176\u4ED6\u8F6F\u996E\u6599"
      ]
    },
    {
      code: "688002.SH",
      name: "\u777F\u521B\u5FAE\u7EB3",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u4E13\u7528\u96C6\u6210\u7535\u8DEF\u3001\u7279\u79CD\u82AF\u7247\u53CAMEMS\u4F20\u611F\u5668\u8BBE\u8BA1\u4E0E\u5236\u9020,\u4E3A\u5168\u7403\u5BA2\u6237\u63D0\u4F9BMEMS\u82AF\u7247\u3001ASIC\u5904\u7406\u5668\u82AF\u7247\u3001\u7EA2\u5916\u70ED\u6210\u50CF\u4E0E\u6D4B\u6E29\u5168\u4EA7\u4E1A\u94FE\u4EA7\u54C1\u3001\u6FC0\u5149\u3001\u5FAE\u6CE2\u4EA7\u54C1\u53CA\u5149\u7535\u7CFB\u7EDF",
      products: [
        "\u7EA2\u5916\u70ED\u6210\u50CF\u4E1A\u52A1",
        "\u7EA2\u5916\u70ED\u6210\u50CF\u4EA7\u54C1\u3001\u5C04\u9891\u5FAE\u6CE2\u5668\u4EF6"
      ]
    },
    {
      code: "688008.SH",
      name: "\u6F9C\u8D77\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u4E91\u8BA1\u7B97\u548C\u4EBA\u5DE5\u667A\u80FD\u9886\u57DF\u63D0\u4F9B\u4EE5\u82AF\u7247\u4E3A\u57FA\u7840\u7684\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u4E92\u8FDE\u7C7B\u82AF\u7247",
        "\u63A5\u53E3\u82AF\u7247\u3001\u670D\u52A1\u5668"
      ]
    },
    {
      code: "688012.SH",
      name: "\u4E2D\u5FAE\u516C\u53F8",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u534A\u5BFC\u4F53\u8BBE\u5907\u53CA\u6CDB\u534A\u5BFC\u4F53\u8BBE\u5907\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u534A\u5BFC\u4F53\u8BBE\u5907\u76F8\u5173\u4EA7\u54C1",
        "\u534A\u5BFC\u4F53\u8BBE\u5907"
      ]
    },
    {
      code: "688017.SH",
      name: "\u7EFF\u7684\u8C10\u6CE2",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u901A\u7528\u8BBE\u5907-\u5176\u4ED6\u901A\u7528\u673A\u68B0",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u901A\u7528\u8BBE\u5907",
        "\u5176\u4ED6\u901A\u7528\u673A\u68B0"
      ],
      mainBusiness: "\u7CBE\u5BC6\u4F20\u52A8\u88C5\u7F6E\u7684\u7814\u53D1\u3001\u8BBE\u8BA1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u8C10\u6CE2\u51CF\u901F\u5668\u53CA\u91D1\u5C5E\u90E8\u4EF6",
        "\u8C10\u6CE2\u51CF\u901F\u5668\u3001\u5DE5\u4E1A\u673A\u5668\u4EBA\u3001\u5DE5\u4E1A\u673A\u5668\u4EBA"
      ]
    },
    {
      code: "688019.SH",
      name: "\u5B89\u96C6\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u6750\u6599"
      ],
      mainBusiness: "\u5173\u952E\u534A\u5BFC\u4F53\u6750\u6599\u7684\u7814\u53D1\u548C\u4EA7\u4E1A\u5316",
      products: [
        "\u5316\u5B66\u673A\u68B0\u629B\u5149\u6DB2",
        "\u5316\u5B66\u673A\u68B0\u629B\u5149\u6DB2\u3001\u529F\u80FD\u6E7F\u7535\u5B50\u5316\u5B66\u54C1"
      ]
    },
    {
      code: "688025.SH",
      name: "\u6770\u666E\u7279",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E\u6FC0\u5149\u5668\u4EE5\u53CA\u4E3B\u8981\u7528\u4E8E\u96C6\u6210\u7535\u8DEF\u548C\u534A\u5BFC\u4F53\u5149\u7535\u76F8\u5173\u5668\u4EF6\u7CBE\u5BC6\u68C0\u6D4B\u53CA\u5FAE\u52A0\u5DE5\u7684\u667A\u80FD\u88C5\u5907",
      products: [
        "\u6FC0\u5149\u5668",
        "\u6FC0\u5149\u5668\u4EF6\u3001\u6FC0\u5149\u8BBE\u5907\u3001\u65E0\u6E90\u5149\u5668\u4EF6"
      ]
    },
    {
      code: "688037.SH",
      name: "\u82AF\u6E90\u5FAE",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u4E13\u7528\u8BBE\u5907-\u5176\u4ED6\u4E13\u7528\u673A\u68B0",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u4E13\u7528\u8BBE\u5907",
        "\u5176\u4ED6\u4E13\u7528\u673A\u68B0"
      ],
      mainBusiness: "\u534A\u5BFC\u4F53\u4E13\u7528\u8BBE\u5907\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u7535\u5B50\u5DE5\u827A\u88C5\u5907",
        "\u534A\u5BFC\u4F53\u6E7F\u6CD5\u5DE5\u827A\u8BBE\u5907\u3001\u534A\u5BFC\u4F53\u8BBE\u5907"
      ]
    },
    {
      code: "688041.SH",
      name: "\u6D77\u5149\u4FE1\u606F",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u7814\u53D1\u3001\u8BBE\u8BA1\u548C\u9500\u552E\u5E94\u7528\u4E8E\u670D\u52A1\u5668\u3001\u5DE5\u4F5C\u7AD9\u7B49\u8BA1\u7B97\u3001\u5B58\u50A8\u8BBE\u5907\u4E2D\u7684\u9AD8\u7AEF\u5904\u7406\u5668",
      products: [
        "\u5904\u7406\u5668",
        "CPU"
      ]
    },
    {
      code: "688048.SH",
      name: "\u957F\u5149\u534E\u82AF",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u6750\u6599"
      ],
      mainBusiness: "\u534A\u5BFC\u4F53\u6FC0\u5149\u82AF\u7247\u7684\u7814\u53D1\u3001\u8BBE\u8BA1\u53CA\u5236\u9020",
      products: [
        "\u9AD8\u529F\u7387\u5355\u7BA1\u7CFB\u5217",
        "\u5149\u901A\u4FE1\u5668\u4EF6\u3001\u5149\u82AF\u7247\u3001\u5149\u901A\u4FE1\u5668\u4EF6"
      ]
    },
    {
      code: "688072.SH",
      name: "\u62D3\u8346\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u9AD8\u7AEF\u534A\u5BFC\u4F53\u4E13\u7528\u8BBE\u5907\u7684\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E\u548C\u6280\u672F\u670D\u52A1\u3002",
      products: [
        "\u534A\u5BFC\u4F53\u4E13\u7528\u8BBE\u5907",
        "\u8584\u819C\u6C89\u79EF\u8BBE\u5907"
      ]
    },
    {
      code: "688082.SH",
      name: "\u76DB\u7F8E\u4E0A\u6D77",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u534A\u5BFC\u4F53\u4E13\u7528\u8BBE\u5907\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u9500\u552E\u5546\u54C1",
        "\u534A\u5BFC\u4F53\u8BBE\u5907\u3001\u534A\u5BFC\u4F53\u8BBE\u5907\u3001\u534A\u5BFC\u4F53\u6E7F\u6CD5\u5DE5\u827A\u8BBE\u5907"
      ]
    },
    {
      code: "688099.SH",
      name: "\u6676\u6668\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u516C\u53F8\u662F\u5168\u7403\u5E03\u5C40\u7684\u65E0\u6676\u5706\u534A\u5BFC\u4F53\u7CFB\u7EDF\u8BBE\u8BA1\u5382\u5546,\u9762\u5411\u667A\u6167\u5BB6\u5EAD\u3001\u667A\u6167\u529E\u516C\u3001\u667A\u6167\u51FA\u884C\u3001\u5A31\u4E50\u6559\u80B2\u3001\u5DE5\u4E1A\u751F\u4EA7\u573A\u666F,\u63D0\u4F9B\u5353\u8D8A\u800C\u9886\u5148\u7684\u667A\u80FD\u7EC8\u7AEF\u63A7\u5236\u4E0E\u8FDE\u63A5\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u667A\u80FD\u591A\u5A92\u4F53\u53CA\u663E\u793ASoC",
        "SoC\u3001SoC\u3001\u7F51\u7EDC\u901A\u4FE1\u82AF\u7247\u3001SoC"
      ]
    },
    {
      code: "688110.SH",
      name: "\u4E1C\u82AF\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u5206\u7ACB\u5668\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u5206\u7ACB\u5668\u4EF6"
      ],
      mainBusiness: "\u4E2D\u5C0F\u5BB9\u91CF\u901A\u7528\u578B\u5B58\u50A8\u82AF\u7247\u7684\u7814\u53D1\u3001\u8BBE\u8BA1\u548C\u9500\u552E",
      products: [
        "NAND\u7CFB\u5217\u4EA7\u54C1",
        "Flash\u82AF\u7247\u3001MCP\u5B58\u50A8\u5668\u3001DRAM\u82AF\u7247\u3001Flash\u82AF\u7247\u3001\u6280\u672F\u670D\u52A1"
      ]
    },
    {
      code: "688111.SH",
      name: "\u91D1\u5C71\u529E\u516C",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u8F6F\u4EF6-\u57FA\u7840\u8F6F\u4EF6",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u8BA1\u7B97\u673A\u8F6F\u4EF6",
        "\u57FA\u7840\u8F6F\u4EF6"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8BWPSOffice\u529E\u516C\u8F6F\u4EF6\u4EA7\u54C1\u53CA\u670D\u52A1\u7684\u8BBE\u8BA1\u7814\u53D1\u53CA\u9500\u552E\u63A8\u5E7F",
      products: [
        "\u56FD\u5185\u4E2A\u4EBA\u529E\u516C\u670D\u52A1\u8BA2\u9605\u4E1A\u52A1",
        "\u5176\u4ED6\u901A\u7528\u7C7B\u5E94\u7528\u8F6F\u4EF6\u3001\u5176\u4ED6\u901A\u7528\u7C7B\u5E94\u7528\u8F6F\u4EF6\u3001\u5176\u4ED6\u901A\u7528\u7C7B\u5E94\u7528\u8F6F\u4EF6"
      ]
    },
    {
      code: "688120.SH",
      name: "\u534E\u6D77\u6E05\u79D1",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u534A\u5BFC\u4F53\u4E13\u7528\u8BBE\u5907\u7684\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E\u53CA\u6280\u672F\u670D\u52A1",
      products: [
        "\u534A\u5BFC\u4F53\u88C5\u5907",
        "\u534A\u5BFC\u4F53\u8BBE\u5907\u3001\u534A\u5BFC\u4F53\u8BBE\u5907\u652F\u6301\u670D\u52A1"
      ]
    },
    {
      code: "688141.SH",
      name: "\u6770\u534E\u7279",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u4EE5\u865A\u62DFIDM\u4E3A\u4E3B\u8981\u7ECF\u8425\u6A21\u5F0F\u7684\u6A21\u62DF\u96C6\u6210\u7535\u8DEF\u8BBE\u8BA1\u4F01\u4E1A,\u4E13\u4E1A\u4ECE\u4E8B\u6A21\u62DF\u96C6\u6210\u7535\u8DEF\u7684\u7814\u53D1\u4E0E\u9500\u552E,\u4E3B\u8981\u91C7\u7528\u516C\u53F8\u81EA\u6709\u7684\u56FD\u9645\u5148\u8FDB\u7684BCD\u5DE5\u827A\u6280\u672F\u8FDB\u884C\u82AF\u7247\u8BBE\u8BA1\u4E0E\u5236\u9020",
      products: [
        "\u7535\u6E90\u7BA1\u7406\u82AF\u7247",
        "\u7535\u6E90\u7BA1\u7406\u82AF\u7247\u3001\u4FE1\u53F7\u94FE\u82AF\u7247\u3001\u529F\u7387\u5668\u4EF6\u3001\u534A\u5BFC\u4F53\u670D\u52A1"
      ]
    },
    {
      code: "688146.SH",
      name: "\u4E2D\u8239\u7279\u6C14",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u65B0\u6750\u6599-\u5316\u5B66\u65B0\u6750\u6599",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u5B66\u65B0\u6750\u6599",
        "\u5316\u5B66\u65B0\u6750\u6599"
      ],
      mainBusiness: "\u7535\u5B50\u7279\u79CD\u6C14\u4F53\u53CA\u4E09\u6C1F\u7532\u78FA\u9178\u7CFB\u5217\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u7535\u5B50\u7279\u79CD\u6C14\u4F53",
        "\u7535\u5B50\u7279\u6C14"
      ]
    },
    {
      code: "688147.SH",
      name: "\u5FAE\u5BFC\u7EB3\u7C73",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u4E13\u6CE8\u4E8E\u5148\u8FDB\u5FAE\u7C73\u7EA7\u3001\u7EB3\u7C73\u7EA7\u8584\u819C\u8BBE\u5907\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u9500\u552E,\u5411\u4E0B\u6E38\u534A\u5BFC\u4F53\u3001\u6CDB\u534A\u5BFC\u4F53\u5BA2\u6237\u63D0\u4F9B\u5C16\u7AEF\u8584\u819C\u8BBE\u5907\u3001\u914D\u5957\u4EA7\u54C1\u53CA\u670D\u52A1",
      products: [
        "\u4E13\u7528\u8BBE\u5907",
        "\u5149\u4F0F\u52A0\u5DE5\u8BBE\u5907\u3001\u534A\u5BFC\u4F53\u8BBE\u5907\u3001\u534A\u5BFC\u4F53\u8BBE\u5907\u96F6\u914D\u4EF6"
      ]
    },
    {
      code: "688200.SH",
      name: "\u534E\u5CF0\u6D4B\u63A7",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u534A\u5BFC\u4F53\u81EA\u52A8\u5316\u6D4B\u8BD5\u7CFB\u7EDF\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u6D4B\u8BD5\u7CFB\u7EDF",
        "\u534A\u5BFC\u4F53\u6D4B\u8BD5\u8BBE\u5907\u3001\u534A\u5BFC\u4F53\u8BBE\u5907\u96F6\u914D\u4EF6"
      ]
    },
    {
      code: "688233.SH",
      name: "\u795E\u5DE5\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u6750\u6599"
      ],
      mainBusiness: "\u5927\u76F4\u5F84\u7845\u6750\u6599\u3001\u7845\u96F6\u90E8\u4EF6\u3001\u534A\u5BFC\u4F53\u5927\u5C3A\u5BF8\u7845\u7247\u53CA\u5176\u5E94\u7528\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u5927\u76F4\u5F84\u7845\u6750\u6599",
        "\u7845\u6750\u6599\u3001\u7845\u6750\u6599\u3001\u7845\u7247"
      ]
    },
    {
      code: "688235.SH",
      name: "\u767E\u6D4E\u795E\u5DDE",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u751F\u7269\u533B\u836F-\u751F\u7269\u533B\u836F",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u751F\u7269\u533B\u836F",
        "\u751F\u7269\u533B\u836F"
      ],
      mainBusiness: "\u6211\u4EEC\u662F\u4E00\u5BB6\u8986\u76D6\u65E9\u671F\u836F\u7269\u53D1\u73B0\u3001\u4E34\u5E8A\u524D\u7814\u7A76\u3001\u5168\u7403\u4E34\u5E8A\u8BD5\u9A8C\u3001\u81EA\u4E3B\u89C4\u6A21\u5316\u836F\u7269\u751F\u4EA7\u4E0E\u5546\u4E1A\u5316\u5168\u94FE\u6761\u7684\u5168\u7403\u80BF\u7624\u521B\u65B0\u516C\u53F8,\u6210\u7ACB\u4EE5\u6765\u5EFA\u7ACB\u4E86\u5B8C\u5584\u7684\u7EC4\u7EC7\u67B6\u6784,\u62E5\u6709\u72EC\u7ACB\u5B8C\u6574\u7684\u7814\u53D1\u3001\u4E34\u5E8A\u3001\u91C7\u8D2D\u3001\u751F\u4EA7\u3001\u9500\u552E\u7B49\u4F53\u7CFB",
      products: [
        "\u836F\u54C1\u9500\u552E",
        "\u6297\u80BF\u7624\u7528\u5316\u836F\u3001\u751F\u7269\u6280\u672F\u670D\u52A1"
      ]
    },
    {
      code: "688256.SH",
      name: "\u5BD2\u6B66\u7EAA",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u5E94\u7528\u4E8E\u5404\u7C7B\u4E91\u670D\u52A1\u5668\u3001\u8FB9\u7F18\u8BA1\u7B97\u8BBE\u5907\u3001\u7EC8\u7AEF\u8BBE\u5907\u4E2D\u4EBA\u5DE5\u667A\u80FD\u6838\u5FC3\u82AF\u7247\u7684\u7814\u53D1\u3001\u8BBE\u8BA1\u548C\u9500\u552E",
      products: [
        "\u4E91\u7AEF\u667A\u80FD\u82AF\u7247\u53CA\u52A0\u901F\u5361",
        "AI\u82AF\u7247\u3001AI\u82AF\u7247\u3001\u534A\u5BFC\u4F53IP\u6388\u6743\u670D\u52A1"
      ]
    },
    {
      code: "688257.SH",
      name: "\u65B0\u9510\u80A1\u4EFD",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u91D1\u5C5E\u5236\u54C1-\u91D1\u5C5E\u5236\u54C1",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u91D1\u5C5E\u5236\u54C1",
        "\u91D1\u5C5E\u5236\u54C1"
      ],
      mainBusiness: "\u786C\u8D28\u5408\u91D1\u53CA\u5DE5\u5177\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u51FF\u5CA9\u5DE5\u5177\u53CA\u914D\u5957\u670D\u52A1",
        "\u94BB\u673A\u914D\u5957\u8BBE\u5907\u3001\u786C\u8D28\u5408\u91D1\u3001\u91D1\u5C5E\u5207\u524A\u5DE5\u5177\u3001\u6CB9\u670D\u88C5\u5907"
      ]
    },
    {
      code: "688266.SH",
      name: "\u6CFD\u749F\u5236\u836F",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u5316\u5B66\u5236\u836F-\u5316\u5B66\u5236\u5242",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u5316\u5B66\u5236\u836F",
        "\u5316\u5B66\u5236\u5242"
      ],
      mainBusiness: "\u5316\u5B66\u65B0\u836F\u53CA\u751F\u7269\u65B0\u836F\u7684\u7814\u53D1\u3001\u751F\u4EA7\u53CA\u9500\u552E",
      products: [
        "\u6388\u6743\u8BB8\u53EF",
        "\u6297\u80BF\u7624\u6CBB\u7597\u836F\u3001\u5176\u4ED6\u533B\u7597\u4FDD\u5065\u7528\u54C1"
      ]
    },
    {
      code: "688271.SH",
      name: "\u8054\u5F71\u533B\u7597",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u533B\u7597\u5668\u68B0-\u533B\u7597\u5668\u68B0",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u533B\u7597\u5668\u68B0",
        "\u533B\u7597\u5668\u68B0"
      ],
      mainBusiness: "\u63D0\u4F9B\u9AD8\u6027\u80FD\u533B\u5B66\u5F71\u50CF\u8BBE\u5907\u3001\u653E\u5C04\u6CBB\u7597\u4EA7\u54C1\u3001\u751F\u547D\u79D1\u5B66\u4EEA\u5668\u53CA\u533B\u7597\u6570\u5B57\u5316\u3001\u667A\u80FD\u5316\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u9AD8\u7AEF\u533B\u5B66\u5F71\u50CF\u8BCA\u65AD\u8BBE\u5907\u53CA\u653E\u5C04\u6CBB\u7597\u8BBE\u5907",
        "\u533B\u7528\u6210\u50CF\u5668\u68B0\u3001\u5176\u4ED6\u533B\u7597\u4FDD\u5065\u8BBE\u5907\u3001\u533B\u7597\u884C\u4E1A\u5E94\u7528\u8F6F\u4EF6"
      ],
      sourceUrl: "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_ORG_BASICINFO&columns=SECUCODE%2CSECURITY_NAME_ABBR%2CEM2016%2CMAIN_BUSINESS%2CMAXPROFIT_PRODUCT%2CPRODUCT_NAME&quoteColumns=&filter=%28SECUCODE%3D%22688271.SH%22%29&pageNumber=1&pageSize=1&sortTypes=&sortColumns=&source=HSF10&client=PC",
      updatedAt: "2026-08-11T09:26:00.394Z"
    },
    {
      code: "688300.SH",
      name: "\u8054\u745E\u65B0\u6750",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u65B0\u6750\u6599-\u5316\u5B66\u65B0\u6750\u6599",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u5B66\u65B0\u6750\u6599",
        "\u5316\u5B66\u65B0\u6750\u6599"
      ],
      mainBusiness: "\u529F\u80FD\u6027\u5148\u8FDB\u7C89\u4F53\u6750\u6599\u7684\u7814\u53D1\u3001\u5236\u9020\u548C\u9500\u552E",
      products: [
        "\u7403\u5F62\u7845\u5FAE\u7C89",
        "\u7845\u5FAE\u7C89\u3001\u7845\u5FAE\u7C89"
      ]
    },
    {
      code: "688301.SH",
      name: "\u5955\u745E\u79D1\u6280",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u533B\u7597\u5668\u68B0-\u533B\u7597\u5668\u68B0",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u533B\u7597\u5668\u68B0",
        "\u533B\u7597\u5668\u68B0"
      ],
      mainBusiness: "\u6570\u5B57\u5316X\u7EBF\u6838\u5FC3\u90E8\u4EF6\u53CA\u7EFC\u5408\u89E3\u51B3\u65B9\u6848\u7684\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E\u4E0E\u670D\u52A1,\u7845\u57FA\u5FAE\u663E\u793A\u80CC\u677F\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u63A2\u6D4B\u5668",
        "\u8BCA\u65ADX\u5C04\u7EBF\u673A\u3001\u6280\u672F\u670D\u52A1\u3001\u8BCA\u65ADX\u5C04\u7EBF\u673A\u3001X\u5C04\u7EBF\u4EEA\u5668\u3001OLED\u663E\u793A\u9762\u677F\u3001\u79DF\u8D41\u670D\u52A1"
      ]
    },
    {
      code: "688313.SH",
      name: "\u4ED5\u4F73\u5149\u5B50",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5668\u4EF6-\u5176\u4ED6\u7535\u5B50\u5668\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5668\u4EF6",
        "\u5176\u4ED6\u7535\u5B50\u5668\u4EF6"
      ],
      mainBusiness: "\u5149\u82AF\u7247\u548C\u5668\u4EF6\u3001\u5BA4\u5185\u5149\u7F06\u548C\u7EBF\u7F06\u9AD8\u5206\u5B50\u6750\u6599\u4E09\u7C7B\u4E1A\u52A1",
      products: [
        "\u5176\u4ED6\u4E1A\u52A1",
        "\u5149\u901A\u4FE1\u5668\u4EF6\u3001\u5BA4\u5185\u5149\u7F06\u3001\u9AD8\u5206\u5B50\u805A\u70EF\u70C3\u5149\u7F06\u6599"
      ]
    },
    {
      code: "688322.SH",
      name: "\u5965\u6BD4\u4E2D\u5149",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "3D\u89C6\u89C9\u611F\u77E5\u4EA7\u54C1\u7684\u8BBE\u8BA1\u3001\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u6D88\u8D39\u7EA7\u5E94\u7528\u8BBE\u5907",
        "\u89C6\u89C9\u8BBE\u5907\u3001\u5149\u7535\u4F20\u611F\u5668\u3001\u89C6\u89C9\u8BBE\u5907"
      ]
    },
    {
      code: "688331.SH",
      name: "\u8363\u660C\u751F\u7269",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u751F\u7269\u533B\u836F-\u751F\u7269\u533B\u836F",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u751F\u7269\u533B\u836F",
        "\u751F\u7269\u533B\u836F"
      ],
      mainBusiness: "\u4E13\u6CE8\u4E8E\u6297\u4F53\u836F\u7269\u5076\u8054\u7269(ADC)\u3001\u6297\u4F53\u878D\u5408\u86CB\u767D\u3001\u5355\u6297\u53CA\u53CC\u6297\u7B49\u6CBB\u7597\u6027\u6297\u4F53\u836F\u7269\u9886\u57DF",
      products: [
        "\u9500\u552E\u5546\u54C1",
        "\u751F\u7269\u79D1\u6280\u3001\u751F\u547D\u79D1\u5B66\u5DE5\u5177\u548C\u670D\u52A1\u3001\u6280\u672F\u670D\u52A1"
      ]
    },
    {
      code: "688347.SH",
      name: "\u534E\u8679\u5B8F\u529B",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u534E\u8679\u534A\u5BFC\u4F53\u662F\u5168\u7403\u9886\u5148\u7684\u7279\u8272\u5DE5\u827A\u6676\u5706\u4EE3\u5DE5\u4F01\u4E1A,\u4E5F\u662F\u884C\u4E1A\u5185\u7279\u8272\u5DE5\u827A\u5E73\u53F0\u8986\u76D6\u6700\u5168\u9762\u7684\u6676\u5706\u4EE3\u5DE5\u4F01\u4E1A\u3002\u516C\u53F8\u7ACB\u8DB3\u4E8E\u5148\u8FDB\u201C\u7279\u8272IC+\u529F\u7387\u5668\u4EF6\u201D\u7684\u6218\u7565\u76EE\u6807,\u4EE5\u62D3\u5C55\u7279\u8272\u5DE5\u827A\u6280\u672F\u4E3A\u57FA\u7840,\u63D0\u4F9B\u5305\u62EC\u5D4C\u5165\u5F0F/\u72EC\u7ACB\u5F0F\u975E\u6613\u5931\u6027\u5B58\u50A8\u5668\u3001\u529F\u7387\u5668\u4EF6\u3001\u6A21\u62DF\u4E0E\u7535\u6E90\u7BA1\u7406\u3001\u903B\u8F91\u4E0E\u5C04\u9891\u7B49\u591A\u5143\u5316\u7279\u8272\u5DE5\u827A\u5E73\u53F0\u7684\u6676\u5706\u4EE3\u5DE5\u53CA\u914D\u5957\u670D\u52A1\u3002",
      products: [
        "\u96C6\u6210\u7535\u8DEF\u6676\u5706\u4EE3\u5DE5"
      ]
    },
    {
      code: "688361.SH",
      name: "\u4E2D\u79D1\u98DE\u6D4B",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u4E13\u7528\u8BBE\u5907-\u5176\u4ED6\u4E13\u7528\u673A\u68B0",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u4E13\u7528\u8BBE\u5907",
        "\u5176\u4ED6\u4E13\u7528\u673A\u68B0"
      ],
      mainBusiness: "\u4E13\u6CE8\u4E8E\u9AD8\u7AEF\u534A\u5BFC\u4F53\u8D28\u91CF\u63A7\u5236\u9886\u57DF,\u4E3A\u534A\u5BFC\u4F53\u884C\u4E1A\u5BA2\u6237\u63D0\u4F9B\u6DB5\u76D6\u8BBE\u5907\u4EA7\u54C1\u3001\u667A\u80FD\u8F6F\u4EF6\u4EA7\u54C1\u548C\u76F8\u5173\u670D\u52A1\u7684\u5168\u6D41\u7A0B\u826F\u7387\u7BA1\u7406\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u68C0\u6D4B\u8BBE\u5907",
        "\u534A\u5BFC\u4F53\u68C0\u6D4B\u8BBE\u5907\u3001\u534A\u5BFC\u4F53\u68C0\u6D4B\u8BBE\u5907"
      ]
    },
    {
      code: "688372.SH",
      name: "\u4F1F\u6D4B\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u6750\u6599"
      ],
      mainBusiness: "\u96C6\u6210\u7535\u8DEF\u6D4B\u8BD5\u670D\u52A1",
      products: [
        "\u6676\u5706\u6D4B\u8BD5",
        "\u6676\u5706\u6D4B\u8BD5\u3001IC\u6210\u54C1\u6D4B\u8BD5"
      ]
    },
    {
      code: "688388.SH",
      name: "\u5609\u5143\u79D1\u6280",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u91D1\u5C5E\u975E\u91D1\u5C5E\u65B0\u6750\u6599-\u7535\u6C60\u6750\u6599",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u91D1\u5C5E\u975E\u91D1\u5C5E\u65B0\u6750\u6599",
        "\u7535\u6C60\u6750\u6599"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u5404\u7C7B\u9AD8\u6027\u80FD\u7535\u89E3\u94DC\u7B94\u7684\u7814\u7A76\u3001\u5236\u9020\u548C\u9500\u552E",
      products: [
        "\u94DC\u7B94",
        "\u9502\u7535\u94DC\u7B94\u3001\u6807\u51C6\u94DC\u7B94"
      ]
    },
    {
      code: "688392.SH",
      name: "\u9A84\u6210\u8D85\u58F0",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u4E13\u7528\u8BBE\u5907-\u5176\u4ED6\u4E13\u7528\u673A\u68B0",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u4E13\u7528\u8BBE\u5907",
        "\u5176\u4ED6\u4E13\u7528\u673A\u68B0"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u8D85\u58F0\u6CE2\u710A\u63A5\u3001\u88C1\u5207\u53CA\u68C0\u6D4B\u8BBE\u5907\u548C\u914D\u4EF6\u7684\u7814\u53D1\u3001\u8BBE\u8BA1\u3001\u751F\u4EA7\u4E0E\u9500\u552E,\u5E76\u4E3A\u5BA2\u6237\u63D0\u4F9B\u914D\u5957\u81EA\u52A8\u5316\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u914D\u4EF6",
        "\u7535\u5B50\u7CBE\u5BC6\u7ED3\u6784\u4EF6\u3001\u7535\u6C60\u751F\u4EA7\u8BBE\u5907\u3001\u7535\u6C60\u751F\u4EA7\u8BBE\u5907\u3001\u7535\u6C60\u751F\u4EA7\u8BBE\u5907\u3001\u7535\u6C60\u751F\u4EA7\u8BBE\u5907"
      ]
    },
    {
      code: "688396.SH",
      name: "\u534E\u6DA6\u5FAE",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u529F\u7387\u534A\u5BFC\u4F53\u3001\u6570\u6A21\u6DF7\u5408\u3001\u667A\u80FD\u4F20\u611F\u5668\u53CA\u667A\u80FD\u63A7\u5236\u4EA7\u54C1\u7684\u8BBE\u8BA1\u3001\u751F\u4EA7\u53CA\u9500\u552E,\u4EE5\u53CA\u63D0\u4F9B\u5F00\u653E\u5F0F\u6676\u5706\u5236\u9020\u3001\u5C01\u88C5\u6D4B\u8BD5\u7B49\u5236\u9020\u670D\u52A1",
      products: [
        "\u5236\u9020\u4E0E\u670D\u52A1",
        "\u534A\u5BFC\u4F53\u4EA7\u54C1\u3001\u534A\u5BFC\u4F53\u5236\u9020\u670D\u52A1"
      ]
    },
    {
      code: "688409.SH",
      name: "\u5BCC\u521B\u7CBE\u5BC6",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u534A\u5BFC\u4F53\u8BBE\u5907\u7CBE\u5BC6\u96F6\u90E8\u4EF6\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u673A\u68B0\u53CA\u673A\u7535\u96F6\u7EC4\u4EF6",
        "\u534A\u5BFC\u4F53\u8BBE\u5907\u96F6\u914D\u4EF6\u3001\u534A\u5BFC\u4F53\u8BBE\u5907\u96F6\u914D\u4EF6"
      ]
    },
    {
      code: "688498.SH",
      name: "\u6E90\u6770\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u5149\u82AF\u7247\u7684\u7814\u53D1\u3001\u8BBE\u8BA1\u3001\u751F\u4EA7\u4E0E\u9500\u552E",
      products: [
        "\u6570\u636E\u4E2D\u5FC3\u7C7B\u53CA\u5176\u4ED6",
        "\u6FC0\u5149\u5668\u82AF\u7247\u3001\u6FC0\u5149\u5668\u82AF\u7247"
      ]
    },
    {
      code: "688503.SH",
      name: "\u805A\u548C\u6750\u6599",
      availability: "available",
      industry: "\u6709\u8272\u91D1\u5C5E-\u91D1\u5C5E\u975E\u91D1\u5C5E\u65B0\u6750\u6599-\u7535\u6C60\u6750\u6599",
      industryLevels: [
        "\u6709\u8272\u91D1\u5C5E",
        "\u91D1\u5C5E\u975E\u91D1\u5C5E\u65B0\u6750\u6599",
        "\u7535\u6C60\u6750\u6599"
      ],
      mainBusiness: "\u65B0\u578B\u7535\u5B50\u6D46\u6599\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u5149\u4F0F\u5BFC\u7535\u6D46\u6599",
        "\u5149\u4F0F\u94F6\u6D46"
      ]
    },
    {
      code: "688506.SH",
      name: "\u767E\u5229\u5929\u6052",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u751F\u7269\u533B\u836F-\u751F\u7269\u533B\u836F",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u751F\u7269\u533B\u836F",
        "\u751F\u7269\u533B\u836F"
      ],
      mainBusiness: "\u836F\u54C1\u7684\u7814\u53D1\u3001\u751F\u4EA7\u4E0E\u8425\u9500",
      products: [
        "\u836F\u54C1\u9500\u552E",
        "\u77E5\u8BC6\u4EA7\u6743\u670D\u52A1\u3001\u5316\u836F\u5236\u5242\u3001\u4E2D\u6210\u836F"
      ]
    },
    {
      code: "688519.SH",
      name: "\u5357\u4E9A\u65B0\u6750",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u8986\u94DC\u677F\u548C\u7C98\u7ED3\u7247\u7B49\u7535\u5B50\u7535\u8DEF\u57FA\u6750\u7684\u8BBE\u8BA1\u3001\u7814\u53D1\u3001\u751F\u4EA7\u53CA\u9500\u552E",
      products: [
        "\u7C98\u7ED3\u7247",
        "\u8986\u94DC\u677F\u3001\u534A\u56FA\u5316\u7247"
      ]
    },
    {
      code: "688521.SH",
      name: "\u82AF\u539F\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u4F9D\u6258\u81EA\u4E3B\u534A\u5BFC\u4F53IP,\u4E3A\u5BA2\u6237\u63D0\u4F9B\u5E73\u53F0\u5316\u3001\u5168\u65B9\u4F4D\u3001\u4E00\u7AD9\u5F0F\u82AF\u7247\u5B9A\u5236\u670D\u52A1\u548C\u534A\u5BFC\u4F53IP\u6388\u6743\u670D\u52A1",
      products: [
        "\u534A\u5BFC\u4F53IP\u6388\u6743\u4E1A\u52A1",
        "\u534A\u5BFC\u4F53\u5236\u9020\u670D\u52A1\u3001\u96C6\u6210\u7535\u8DEF\u8BBE\u8BA1\u3001\u534A\u5BFC\u4F53IP\u6388\u6743\u670D\u52A1\u3001\u534A\u5BFC\u4F53IP\u6388\u6743\u670D\u52A1"
      ]
    },
    {
      code: "688525.SH",
      name: "\u4F70\u7EF4\u5B58\u50A8",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u534A\u5BFC\u4F53\u5B58\u50A8\u5668\u7684\u7814\u53D1\u8BBE\u8BA1\u3001\u5C01\u88C5\u6D4B\u8BD5\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u5B58\u50A8\u4EA7\u54C1",
        "\u5B58\u50A8\u8BBE\u5907\u3001\u534A\u5BFC\u4F53\u5C01\u6D4B\u670D\u52A1"
      ]
    },
    {
      code: "688536.SH",
      name: "\u601D\u745E\u6D66",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u6A21\u62DF\u96C6\u6210\u7535\u8DEF\u4EA7\u54C1\u7684\u7814\u53D1\u4E0E\u9500\u552E",
      products: [
        "\u4FE1\u53F7\u94FE\u7C7B\u6A21\u62DF\u82AF\u7247",
        "\u4FE1\u53F7\u94FE\u82AF\u7247\u3001\u7535\u6E90\u7BA1\u7406\u82AF\u7247"
      ]
    },
    {
      code: "688548.SH",
      name: "\u5E7F\u94A2\u6C14\u4F53",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u5236\u54C1-\u5176\u4ED6\u5316\u5B66\u5236\u54C1",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u5B66\u5236\u54C1",
        "\u5176\u4ED6\u5316\u5B66\u5236\u54C1"
      ],
      mainBusiness: "\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E\u4EE5\u7535\u5B50\u5927\u5B97\u6C14\u4F53\u4E3A\u6838\u5FC3\u7684\u5DE5\u4E1A\u6C14\u4F53",
      products: [
        "\u7535\u5B50\u5927\u5B97\u6C14\u4F53",
        "\u7535\u5B50\u7279\u6C14\u3001\u5DE5\u4E1A\u6C14\u4F53"
      ]
    },
    {
      code: "688578.SH",
      name: "\u827E\u529B\u65AF",
      availability: "available",
      industry: "\u533B\u836F\u751F\u7269-\u5316\u5B66\u5236\u836F-\u5316\u5B66\u5236\u5242",
      industryLevels: [
        "\u533B\u836F\u751F\u7269",
        "\u5316\u5B66\u5236\u836F",
        "\u5316\u5B66\u5236\u5242"
      ],
      mainBusiness: "\u4E13\u6CE8\u4E8E\u80BF\u7624\u6CBB\u7597\u9886\u57DF\u7684\u521B\u65B0\u836F\u4F01\u4E1A,\u76EE\u524D\u5DF2\u5728\u975E\u5C0F\u7EC6\u80DE\u80BA\u764C(NSCLC)\u5C0F\u5206\u5B50\u9776\u5411\u836F\u9886\u57DF\u6784\u5EFA\u4E86\u4F18\u52BF\u7814\u53D1\u7BA1\u7EBF",
      products: [
        "\u6297\u80BF\u7624\u7C7B",
        "\u6297\u80BF\u7624\u6CBB\u7597\u836F\u3001\u6388\u6743\u8BB8\u53EF"
      ]
    },
    {
      code: "688627.SH",
      name: "\u7CBE\u667A\u8FBE",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u6D4B\u8BD5\u68C0\u6D4B\u8BBE\u5907\u4E0E\u7CFB\u7EDF\u89E3\u51B3\u65B9\u6848\u63D0\u4F9B\u5546,\u4E3B\u8981\u4ECE\u4E8B\u534A\u5BFC\u4F53\u68C0\u6D4B\u8BBE\u5907\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E\u4E1A\u52A1",
      products: [
        "\u65B0\u578B\u663E\u793A\u5668\u4EF6\u68C0\u6D4B\u8BBE\u5907\u9886\u57DF",
        "\u4E13\u7528\u8BBE\u5907\u3001\u68C0\u6D4B\u670D\u52A1"
      ]
    },
    {
      code: "688629.SH",
      name: "\u534E\u4E30\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u8BBE\u5907\u5236\u9020-\u7535\u5B50\u8BBE\u5907\u5236\u9020",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020",
        "\u7535\u5B50\u8BBE\u5907\u5236\u9020"
      ],
      mainBusiness: "\u5149\u3001\u7535\u8FDE\u63A5\u5668\u53CA\u7EBF\u7F06\u7EC4\u4EF6\u7684\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E,\u5E76\u4E3A\u5BA2\u6237\u63D0\u4F9B\u7CFB\u7EDF\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u7EC4\u4EF6",
        "\u8FDE\u63A5\u5668\u3001\u8FDE\u63A5\u5668\u3001\u8FDE\u63A5\u5668"
      ]
    },
    {
      code: "688630.SH",
      name: "\u82AF\u7881\u5FAE\u88C5",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u4E13\u7528\u8BBE\u5907-\u5176\u4ED6\u4E13\u7528\u673A\u68B0",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u4E13\u7528\u8BBE\u5907",
        "\u5176\u4ED6\u4E13\u7528\u673A\u68B0"
      ],
      mainBusiness: "\u4E13\u4E1A\u4ECE\u4E8B\u4EE5\u5FAE\u7EB3\u76F4\u5199\u5149\u523B\u4E3A\u6280\u672F\u6838\u5FC3\u7684\u76F4\u63A5\u6210\u50CF\u8BBE\u5907\u53CA\u76F4\u5199\u5149\u523B\u8BBE\u5907\u7684\u7814\u53D1\u3001\u5236\u9020\u3001\u9500\u552E\u4EE5\u53CA\u76F8\u5E94\u7684\u7EF4\u4FDD\u670D\u52A1",
      products: [
        "PCB",
        "PCB\u751F\u4EA7\u8BBE\u5907\u3001\u5149\u523B\u673A\u3001\u878D\u8D44\u79DF\u8D41"
      ]
    },
    {
      code: "688635.SH",
      name: "\u957F\u8FDB\u5149\u5B50",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u5149\u7535\u5B50\u5668\u4EF6-\u5149\u5B66\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u5149\u7535\u5B50\u5668\u4EF6",
        "\u5149\u5B66\u5143\u4EF6"
      ],
      mainBusiness: "\u7279\u79CD\u5149\u7EA4\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u63BA\u7A00\u571F\u5149\u7EA4",
        "\u5149\u7EA4"
      ],
      sourceUrl: "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_ORG_BASICINFO&columns=SECUCODE%2CSECURITY_NAME_ABBR%2CEM2016%2CMAIN_BUSINESS%2CMAXPROFIT_PRODUCT%2CPRODUCT_NAME&quoteColumns=&filter=%28SECUCODE%3D%22688635.SH%22%29&pageNumber=1&pageSize=1&sortTypes=&sortColumns=&source=HSF10&client=PC",
      updatedAt: "2026-08-11T09:26:00.331Z"
    },
    {
      code: "688668.SH",
      name: "\u9F0E\u901A\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u751F\u4EA7\u548C\u9500\u552E\u901A\u8BAF\u8FDE\u63A5\u5668\u7EC4\u4EF6\u3001\u6C7D\u8F66\u8FDE\u63A5\u5668\u7EC4\u4EF6\u3001\u6A21\u5177\u548C\u6A21\u5177\u96F6\u4EF6",
      products: [
        "\u901A\u8BAF\u8FDE\u63A5\u5668\u7EC4\u4EF6(\u5408\u5E76)",
        "\u5149\u7EA4\u8FDE\u63A5\u5668\u3001\u901A\u8BAF\u8FDE\u63A5\u5668\u3001\u6C7D\u8F66\u8FDE\u63A5\u5668\u3001\u901A\u8BAF\u8FDE\u63A5\u5668\u3001\u7CBE\u5BC6\u6A21\u5177\u3001\u6A21\u5177\u3001\u901A\u8BAF\u8FDE\u63A5\u5668"
      ]
    },
    {
      code: "688702.SH",
      name: "\u76DB\u79D1\u901A\u4FE1",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u4EE5\u592A\u7F51\u4EA4\u6362\u82AF\u7247\u53CA\u914D\u5957\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u8BBE\u8BA1\u548C\u9500\u552E",
      products: [
        "\u4EE5\u592A\u7F51\u4EA4\u6362\u82AF\u7247",
        "\u7F51\u7EDC\u901A\u4FE1\u82AF\u7247\u3001\u901A\u8BAF\u6A21\u5757\u3001\u4EE5\u592A\u7F51\u4EA4\u6362\u673A\u3001\u6388\u6743\u8BB8\u53EF\u3001\u901A\u4FE1\u7F51\u7EDC\u6280\u672F\u670D\u52A1"
      ]
    },
    {
      code: "688766.SH",
      name: "\u666E\u5189\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u5206\u7ACB\u5668\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u5206\u7ACB\u5668\u4EF6"
      ],
      mainBusiness: "\u975E\u6613\u5931\u6027\u5B58\u50A8\u5668\u82AF\u7247\u53CA\u57FA\u4E8E\u5B58\u50A8\u82AF\u7247\u7684\u884D\u751F\u82AF\u7247\u7684\u8BBE\u8BA1\u4E0E\u9500\u552E",
      products: [
        "\u82AF\u7247",
        "\u5B58\u50A8\u5668\u82AF\u7247\u3001MCU"
      ]
    },
    {
      code: "688777.SH",
      name: "\u4E2D\u63A7\u6280\u672F",
      availability: "available",
      industry: "\u4FE1\u606F\u6280\u672F-\u8BA1\u7B97\u673A\u8F6F\u4EF6-\u5176\u4ED6\u8F6F\u4EF6\u670D\u52A1",
      industryLevels: [
        "\u4FE1\u606F\u6280\u672F",
        "\u8BA1\u7B97\u673A\u8F6F\u4EF6",
        "\u5176\u4ED6\u8F6F\u4EF6\u670D\u52A1"
      ],
      mainBusiness: "\u4EE5\u5DE5\u4E1A\u6570\u636E\u4E3A\u57FA\u7840\u3001AI\u5927\u6A21\u578B\u4E3A\u6838\u5FC3\u3001\u5168\u573A\u666F\u667A\u80FD\u4F53\u4E3A\u89E6\u624B\u7684\u5DE5\u4E1AAI\u5E73\u53F0\u578B\u516C\u53F8",
      products: [
        "\u667A\u80FD\u5236\u9020\u89E3\u51B3\u65B9\u6848",
        "\u5DE5\u4E1A\u673A\u5668\u4EBA\u3001\u5DE5\u4E1A\u81EA\u52A8\u5316\u4EEA\u8868\u3001\u5E94\u7528\u5206\u53D1\u5E73\u53F0\u63D0\u4F9B\u5546\u3001\u5DE5\u4E1A\u5E94\u7528\u8F6F\u4EF6\u3001\u6280\u672F\u670D\u52A1"
      ]
    },
    {
      code: "688781.SH",
      name: "\u89C6\u6DAF\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5668\u4EF6-\u663E\u793A\u5668\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5668\u4EF6",
        "\u663E\u793A\u5668\u4EF6"
      ],
      mainBusiness: "\u7845\u57FAOLED\u5FAE\u578B\u663E\u793A\u5C4F\u3001\u5149\u5B66\u7CFB\u7EDF\u548CXR\u6574\u4F53\u89E3\u51B3\u65B9\u6848\u7684\u7814\u53D1\u3001\u751F\u4EA7\u5236\u9020\u548C\u9500\u552E\u3001\u6218\u7565\u4EA7\u54C1\u5F00\u53D1",
      products: [
        "OLED\u663E\u793A\u9762\u677F\u3001OLED\u663E\u793A\u9762\u677F\u3001XR\u8BBE\u5907"
      ]
    },
    {
      code: "688783.SH",
      name: "\u897F\u5B89\u5955\u6750",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u6750\u6599"
      ],
      mainBusiness: "12\u82F1\u5BF8\u7845\u7247\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u629B\u5149\u7247",
        "\u7535\u5B50\u7EA7\u5355\u6676\u7845\u7247\u3001\u534A\u5BFC\u4F53\u7845\u629B\u5149\u7247\u3001\u5916\u5EF6\u7247"
      ]
    },
    {
      code: "688785.SH",
      name: "\u6052\u8FD0\u660C",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u6750\u6599"
      ],
      mainBusiness: "\u7B49\u79BB\u5B50\u4F53\u5C04\u9891\u7535\u6E90\u7CFB\u7EDF\u3001\u7B49\u79BB\u5B50\u4F53\u6FC0\u53D1\u88C5\u7F6E\u3001\u7B49\u79BB\u5B50\u4F53\u76F4\u6D41\u7535\u6E90\u3001\u5404\u79CD\u914D\u4EF6\u7684\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E\u53CA\u6280\u672F\u670D\u52A1,\u5E76\u5F15\u8FDB\u771F\u7A7A\u83B7\u5F97\u548C\u6D41\u4F53\u63A7\u5236\u7B49\u76F8\u5173\u7684\u6838\u5FC3\u96F6\u90E8\u4EF6,\u56F4\u7ED5\u7B49\u79BB\u5B50\u4F53\u5DE5\u827A\u63D0\u4F9B\u6838\u5FC3\u96F6\u90E8\u4EF6\u6574\u4F53\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u81EA\u7814\u4EA7\u54C1",
        "\u534A\u5BFC\u4F53\u8BBE\u5907\u96F6\u914D\u4EF6\u3001\u534A\u5BFC\u4F53\u8BBE\u5907\u96F6\u914D\u4EF6\u3001\u6280\u672F\u670D\u52A1"
      ]
    },
    {
      code: "688790.SH",
      name: "\u6602\u745E\u5FAE",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u4ECE\u4E8B\u5C04\u9891\u524D\u7AEF\u82AF\u7247\u3001\u5C04\u9891SoC\u82AF\u7247\u53CA\u5176\u4ED6\u6A21\u62DF\u82AF\u7247\u7684\u7814\u53D1\u3001\u8BBE\u8BA1\u4E0E\u9500\u552E",
      products: [
        "\u5C04\u9891\u524D\u7AEF\u82AF\u7247",
        "\u5C04\u9891\u82AF\u7247\u3001\u5C04\u9891\u82AF\u7247"
      ]
    },
    {
      code: "688795.SH",
      name: "\u6469\u5C14\u7EBF\u7A0B",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "GPU\u53CA\u76F8\u5173\u4EA7\u54C1\u7684\u7814\u53D1\u3001\u8BBE\u8BA1\u548C\u9500\u552E",
      products: [
        "\u4E91\u7AEF\u4EA7\u54C1",
        "GPU\u3001GPU"
      ]
    },
    {
      code: "688797.SH",
      name: "\u81FB\u5B9D\u79D1\u6280",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u534A\u5BFC\u4F53\u6750\u6599",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u534A\u5BFC\u4F53\u6750\u6599"
      ],
      mainBusiness: "\u4E3A\u96C6\u6210\u7535\u8DEF\u53CA\u663E\u793A\u9762\u677F\u884C\u4E1A\u5BA2\u6237\u63D0\u4F9B\u5236\u9020\u8BBE\u5907\u771F\u7A7A\u8154\u4F53\u5185\u53C2\u4E0E\u5DE5\u827A\u53CD\u5E94\u7684\u96F6\u90E8\u4EF6\u53CA\u5176\u8868\u9762\u5904\u7406\u89E3\u51B3\u65B9\u6848",
      products: [
        "\u96F6\u90E8\u4EF6",
        "\u663E\u793A\u5668\u4EF6\u3001\u5DE5\u7A0B\u7BA1\u7406"
      ]
    },
    {
      code: "688802.SH",
      name: "\u6C90\u66E6\u80A1\u4EFD",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u7814\u53D1\u3001\u8BBE\u8BA1\u548C\u9500\u552E\u5E94\u7528\u4E8E\u4EBA\u5DE5\u667A\u80FD\u8BAD\u7EC3\u548C\u63A8\u7406\u3001\u901A\u7528\u8BA1\u7B97(\u5305\u62EC\u79D1\u5B66\u8BA1\u7B97)\u4E0E\u56FE\u5F62\u6E32\u67D3\u9886\u57DF\u7684\u5168\u6808GPU\u4EA7\u54C1,\u5E76\u56F4\u7ED5GPU\u82AF\u7247\u63D0\u4F9B\u914D\u5957\u7684\u8F6F\u4EF6\u6808\u4E0E\u8BA1\u7B97\u5E73\u53F0",
      products: [
        "GPU\u4EA7\u54C1\u53CA\u914D\u4EF6",
        "GPU\u3001\u534A\u5BFC\u4F53IP\u6388\u6743\u670D\u52A1"
      ]
    },
    {
      code: "688808.SH",
      name: "\u8054\u8BAF\u4EEA\u5668",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u901A\u7528\u8BBE\u5907-\u4EEA\u5668\u4EEA\u8868",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u901A\u7528\u8BBE\u5907",
        "\u4EEA\u5668\u4EEA\u8868"
      ],
      mainBusiness: "\u7535\u5B50\u6D4B\u91CF\u4EEA\u5668\u548C\u534A\u5BFC\u4F53\u6D4B\u8BD5\u8BBE\u5907\u7684\u7814\u53D1\u3001\u5236\u9020\u3001\u9500\u552E\u53CA\u670D\u52A1",
      products: [
        "\u7535\u5B50\u6D4B\u91CF\u4EEA\u5668",
        "\u7535\u5B50\u6D4B\u91CF\u4EEA\u5668\u3001\u534A\u5BFC\u4F53\u6D4B\u8BD5\u8BBE\u5907\u3001\u7535\u5B50\u6D4B\u91CF\u4EEA\u5668\u3001\u534A\u5BFC\u4F53\u6D4B\u8BD5\u8BBE\u5907"
      ]
    },
    {
      code: "688813.SH",
      name: "\u6CF0\u91D1\u65B0\u80FD",
      availability: "available",
      industry: "\u673A\u68B0\u8BBE\u5907-\u4E13\u7528\u8BBE\u5907-\u5176\u4ED6\u4E13\u7528\u673A\u68B0",
      industryLevels: [
        "\u673A\u68B0\u8BBE\u5907",
        "\u4E13\u7528\u8BBE\u5907",
        "\u5176\u4ED6\u4E13\u7528\u673A\u68B0"
      ],
      mainBusiness: "\u4E13\u6CE8\u4E8E\u9AD8\u7AEF\u7EFF\u8272\u7535\u89E3\u6210\u5957\u88C5\u5907\u3001\u949B\u7535\u6781\u4EE5\u53CA\u91D1\u5C5E\u73BB\u7483\u5C01\u63A5\u5236\u54C1\u7684\u7814\u53D1\u3001\u8BBE\u8BA1\u3001\u751F\u4EA7\u53CA\u9500\u552E",
      products: [
        "\u4E13\u7528\u8BBE\u5907\u3001\u4E13\u7528\u8BBE\u5907\u3001\u5176\u4ED6\u91D1\u5C5E\u65B0\u6750\u6599\u3001\u7535\u5B50\u5C01\u88C5\u6750\u6599"
      ]
    },
    {
      code: "688818.SH",
      name: "\u7535\u79D1\u84DD\u5929",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u7535\u6E90\u8BBE\u5907-\u50A8\u80FD\u8BBE\u5907",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u7535\u6E90\u8BBE\u5907",
        "\u50A8\u80FD\u8BBE\u5907"
      ],
      mainBusiness: "\u7535\u80FD\u6E90\u4EA7\u54C1\u53CA\u7CFB\u7EDF\u7684\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E\u53CA\u670D\u52A1",
      products: [
        "\u5B87\u822A\u7535\u6E90",
        "\u7EFC\u5408\u80FD\u6E90\u670D\u52A1\u3001\u7EFC\u5408\u80FD\u6E90\u670D\u52A1\u3001\u5176\u4ED6\u7535\u6E90\u8BBE\u5907"
      ]
    },
    {
      code: "688820.SH",
      name: "\u76DB\u5408\u6676\u5FAE",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u4E2D\u6BB5\u7845\u7247\u52A0\u5DE5\u3001\u6676\u5706\u7EA7\u5C01\u88C5\u3001\u82AF\u7C92\u591A\u82AF\u7247\u96C6\u6210\u5C01\u88C5\u7B49\u6676\u5706\u7EA7\u5148\u8FDB\u5C01\u6D4B\u670D\u52A1",
      products: [
        "\u82AF\u7C92\u591A\u82AF\u7247\u96C6\u6210\u5C01\u88C5",
        "\u7845\u7247\u3001\u96C6\u6210\u7535\u8DEF\u5C01\u88C5\u670D\u52A1\u3001\u7845\u7247\u3001\u96C6\u6210\u7535\u8DEF\u5C01\u88C5\u670D\u52A1"
      ]
    },
    {
      code: "688981.SH",
      name: "\u4E2D\u82AF\u56FD\u9645",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u534A\u5BFC\u4F53-\u96C6\u6210\u7535\u8DEF",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u534A\u5BFC\u4F53",
        "\u96C6\u6210\u7535\u8DEF"
      ],
      mainBusiness: "\u4E3B\u8981\u4ECE\u4E8B\u57FA\u4E8E\u591A\u79CD\u6280\u672F\u8282\u70B9\u548C\u6280\u672F\u5E73\u53F0\u7684\u96C6\u6210\u7535\u8DEF\u6676\u5706\u4EE3\u5DE5\u4E1A\u52A1,\u5E76\u63D0\u4F9B\u8BBE\u8BA1\u670D\u52A1\u4E0EIP\u652F\u6301\u3001\u5149\u63A9\u6A21\u5236\u9020\u7B49\u914D\u5957\u670D\u52A1",
      products: [
        "\u96C6\u6210\u7535\u8DEF\u6676\u5706\u4EE3\u5DE5"
      ]
    },
    {
      code: "689009.SH",
      name: "\u4E5D\u53F7\u516C\u53F8",
      availability: "available",
      industry: "\u4EA4\u8FD0\u8BBE\u5907-\u5176\u4ED6\u4EA4\u8FD0\u8BBE\u5907-\u5176\u4ED6\u4EA4\u8FD0\u8BBE\u5907",
      industryLevels: [
        "\u4EA4\u8FD0\u8BBE\u5907",
        "\u5176\u4ED6\u4EA4\u8FD0\u8BBE\u5907",
        "\u5176\u4ED6\u4EA4\u8FD0\u8BBE\u5907"
      ],
      mainBusiness: "\u667A\u80FD\u77ED\u4EA4\u901A\u548C\u670D\u52A1\u7C7B\u673A\u5668\u4EBA\u4EA7\u54C1\u7684\u8BBE\u8BA1\u3001\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E\u53CA\u670D\u52A1\u3002",
      products: [
        "\u7535\u52A8\u4E24\u8F6E\u8F66\u548C\u7535\u8E0F\u8F66"
      ]
    },
    {
      code: "920011.BJ",
      name: "\u6668\u5149\u7535\u673A",
      availability: "available",
      industry: "\u7535\u6C14\u8BBE\u5907-\u7535\u673A-\u7535\u673A",
      industryLevels: [
        "\u7535\u6C14\u8BBE\u5907",
        "\u7535\u673A",
        "\u7535\u673A"
      ],
      mainBusiness: "\u516C\u53F8\u4E13\u4E1A\u4ECE\u4E8B\u5FAE\u7279\u7535\u673A\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E,\u4EA7\u54C1\u5E7F\u6CDB\u5E94\u7528\u4E8E\u4EE5\u5438\u5C18\u5668\u4E3A\u4E3B\u7684\u6E05\u6D01\u7535\u5668\u9886\u57DF",
      products: [
        "\u4EA4\u6D41\u4E32\u6FC0\u7535\u673A",
        "\u5FAE\u7279\u7535\u673A\u3001\u5FAE\u7279\u7535\u673A\u3001\u65E0\u5237\u76F4\u6D41\u7535\u673A\u3001\u65E0\u5237\u76F4\u6D41\u7535\u673A\u3001\u6709\u5237\u76F4\u6D41\u7535\u673A\u3001\u6709\u5237\u76F4\u6D41\u7535\u673A"
      ]
    },
    {
      code: "920136.BJ",
      name: "\u6C38\u52B1\u7CBE\u5BC6",
      availability: "available",
      industry: "\u4EA4\u8FD0\u8BBE\u5907-\u6C7D\u8F66-\u6C7D\u8F66\u96F6\u90E8\u4EF6",
      industryLevels: [
        "\u4EA4\u8FD0\u8BBE\u5907",
        "\u6C7D\u8F66",
        "\u6C7D\u8F66\u96F6\u90E8\u4EF6"
      ],
      mainBusiness: "\u6C7D\u8F66\u7528\u7CBE\u5BC6\u94A2\u7BA1\u53CA\u7BA1\u578B\u96F6\u90E8\u4EF6\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u5E95\u76D8\u7CFB\u7EDF",
        "\u6C7D\u8F66\u96F6\u4EF6\u4E0E\u8BBE\u5907\u3001\u6C7D\u8F66\u5E95\u76D8\u7CFB\u7EDF\u3001\u6C7D\u8F66\u5E95\u76D8\u7CFB\u7EDF\u3001\u6C7D\u8F66\u8F6C\u5411\u7CFB\u7EDF\u3001\u6C7D\u8F66\u8F6C\u5411\u7CFB\u7EDF\u3001\u6C7D\u8F66\u53D1\u52A8\u673A\u3001\u6C7D\u8F66\u53D1\u52A8\u673A"
      ]
    },
    {
      code: "920181.BJ",
      name: "\u8D5B\u82F1\u7535\u5B50",
      availability: "available",
      industry: "\u7535\u5B50\u8BBE\u5907-\u7535\u5B50\u5143\u4EF6-\u7535\u5B50\u5143\u4EF6",
      industryLevels: [
        "\u7535\u5B50\u8BBE\u5907",
        "\u7535\u5B50\u5143\u4EF6",
        "\u7535\u5B50\u5143\u4EF6"
      ],
      mainBusiness: "\u9676\u74F7\u7BA1\u58F3\u548C\u5C01\u88C5\u6563\u70ED\u57FA\u677F\u7B49\u529F\u7387\u534A\u5BFC\u4F53\u5668\u4EF6\u5173\u952E\u90E8\u4EF6\u7684\u7814\u53D1\u3001\u5236\u9020\u548C\u9500\u552E",
      products: [
        "\u9676\u74F7\u7BA1\u58F3\u53CA\u7EC4\u4EF6",
        "\u5C01\u88C5\u57FA\u677F\u3001\u7535\u5B50\u9676\u74F7"
      ]
    },
    {
      code: "920189.BJ",
      name: "\u5EB7\u7F8E\u7279",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u65B0\u6750\u6599-\u5316\u5B66\u65B0\u6750\u6599",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u5B66\u65B0\u6750\u6599",
        "\u5316\u5B66\u65B0\u6750\u6599"
      ],
      mainBusiness: "\u4ECE\u4E8B\u7535\u5B50\u5C01\u88C5\u6750\u6599\u53CA\u9AD8\u6027\u80FD\u6539\u6027\u5851\u6599\u7B49\u9AD8\u5206\u5B50\u65B0\u6750\u6599\u4EA7\u54C1\u7814\u53D1\u3001\u751F\u4EA7\u3001\u9500\u552E",
      products: [
        "\u7535\u5B50\u5C01\u88C5\u6750\u6599",
        "\u7535\u5B50\u5C01\u88C5\u6750\u6599\u3001\u6539\u6027\u5851\u6599"
      ]
    },
    {
      code: "920193.BJ",
      name: "\u5409\u548C\u660C",
      availability: "available",
      industry: "\u57FA\u7840\u5316\u5DE5-\u5316\u5B66\u5236\u54C1-\u5176\u4ED6\u5316\u5B66\u5236\u54C1",
      industryLevels: [
        "\u57FA\u7840\u5316\u5DE5",
        "\u5316\u5B66\u5236\u54C1",
        "\u5176\u4ED6\u5316\u5B66\u5236\u54C1"
      ],
      mainBusiness: "\u8868\u9762\u4E0E\u754C\u9762\u5904\u7406\u76F8\u5173\u7279\u79CD\u529F\u80FD\u6027\u6750\u6599\u7684\u7814\u53D1\u3001\u751F\u4EA7\u548C\u9500\u552E",
      products: [
        "\u65B0\u80FD\u6E90\u7535\u6C60\u6750\u6599",
        "\u7535\u6C60\u6750\u6599\u3001\u5176\u4ED6\u7279\u79CD\u8868\u9762\u6D3B\u6027\u5242\u3001\u5316\u5DE5\u52A9\u5242"
      ]
    }
  ]
};

// src/modules/research/application/research-investment-analysis.ts
var TASK_TYPE2 = "webqa.chatgpt.v1";
var MODEL2 = "gpt-5.6-luna";
var DEFAULT_REASONING_EFFORT2 = "xhigh";
var PROMPT_VERSION = "investment-analysis.taskd.v7";
var INVESTMENT_ANALYSIS_NAMESPACE = "research_investment_analysis";
function researchInvestmentAnalysisTaskName(securityCode) {
  return `research:investment-analysis:${securityCode}`;
}
async function enqueueResearchInvestmentAnalysis(env, securityCode, options = {}) {
  const prepared = await prepareResearchInvestmentAnalysis(env, securityCode);
  const current = await loadResult2(env.DB, prepared.securityCode);
  const name = researchInvestmentAnalysisTaskName(prepared.securityCode);
  const normalizedReasoningEffort = normalizeReasoningEffort2(options.reasoningEffort);
  const task = await taskdCallerClient(env).submit({
    name,
    taskType: TASK_TYPE2,
    payload: {
      ...taskdWebQaInput(env, {
        model: MODEL2,
        reasoningEffort: normalizedReasoningEffort,
        waitTimeoutMs: 2 * 60 * 6e4,
        messages: [{ role: "user", content: prepared.prompt }]
      }, name),
      // The executor ignores this field; it is retained in taskd with the
      // exact engineering snapshot that produced the submitted prompt.
      business_input: prepared.input
    },
    diagnostics: {
      securityCode: prepared.securityCode,
      model: MODEL2,
      reasoningEffort: normalizedReasoningEffort,
      promptVersion: prepared.input.promptVersion,
      schemaVersion: prepared.input.schemaVersion
    }
  });
  await storeResult2(env.DB, prepared.securityCode, mergeStoredResult2(current, {
    inputJson: JSON.stringify(prepared.input),
    task: taskView2(task),
    recovery: noRecovery()
  }));
  return { accepted: true, task: taskView2(task), input: prepared.input };
}
async function loadResearchInvestmentAnalysis(env, securityCode) {
  const code = securityCode.trim().toUpperCase();
  let result = await loadResult2(env.DB, code);
  if (result?.markdown && !isPendingTask2(result.task)) return responseFromStoredResult2(result);
  const cachedInput = jsonObject(result?.inputJson);
  const shouldQueryTaskd = env.LLM_RUNTIME === "local" && (!result?.markdown || isPendingTask2(result.task));
  let prepared = null;
  const ensurePrepared = async () => {
    if (!prepared) prepared = await prepareResearchInvestmentAnalysis(env, code);
    return prepared;
  };
  let task = result?.task ?? null;
  if (shouldQueryTaskd) {
    const state = await reconcileTaskdResult(taskdCallerClient(env), {
      name: researchInvestmentAnalysisTaskName(code),
      project: async (currentTask) => projectResearchInvestmentAnalysis(env, taskBusinessInput(currentTask) || cachedInput || (await ensurePrepared()).input, currentTask)
    });
    switch (state.state) {
      case "projected":
        result = state.value;
        task = state.value.task;
        break;
      case "pending":
      case "failed":
      case "interrupted":
      case "superseded":
        task = taskView2(state.task);
        result = await persistTaskSnapshot2(
          env.DB,
          code,
          result,
          taskBusinessInput(state.task) || cachedInput || (await ensurePrepared()).input,
          state.task,
          recoveryAfterTask(result?.recovery ?? noRecovery(), state.task)
        );
        break;
      case "missing":
        task = null;
        if (result?.task) result = await persistTaskSnapshot2(env.DB, code, result, cachedInput, null, {
          phase: "manual_required",
          reason: "taskd \u5DF2\u627E\u4E0D\u5230\u539F\u4EFB\u52A1\uFF0C\u65E0\u6CD5\u786E\u8BA4\u5DF2\u63D0\u4EA4\u7684 ChatGPT \u4F1A\u8BDD\u3002"
        });
        break;
    }
  }
  if (result) return responseFromStoredResult2(result);
  const fallbackInput = cachedInput || (await ensurePrepared()).input;
  return {
    availability: task?.status === "failed" ? "failed" : task ? "pending" : "empty",
    task: task ? taskView2(task) : null,
    recovery: noRecovery(),
    input: fallbackInput,
    report: null,
    resume: { available: task?.status === "failed", reason: task?.status === "failed" ? "submit_new_task" : "not_failed" }
  };
}
async function resumeResearchInvestmentAnalysis(env, securityCode) {
  const code = securityCode.trim().toUpperCase();
  const stored = await loadResult2(env.DB, code);
  if (!stored?.task) throw new Error("investment analysis has no recorded task to recover");
  if (env.LLM_RUNTIME !== "local") throw new Error("investment analysis recovery is only available in local LLM runtime");
  const client = taskdCallerClient(env);
  let remote = await client.get(stored.task.name);
  let recovery = stored.recovery;
  if (!remote) {
    recovery = {
      phase: "manual_required",
      reason: "taskd \u5DF2\u627E\u4E0D\u5230\u539F\u4EFB\u52A1\uFF0C\u65E0\u6CD5\u786E\u8BA4\u5DF2\u63D0\u4EA4\u7684 ChatGPT \u4F1A\u8BDD\u3002"
    };
  } else if (remote.status === "failed") {
    if (hasProviderSubmissionMarker(remote.checkpoint)) {
      remote = await client.recover(stored.task.name);
      recovery = remote ? {
        phase: "recovering",
        reason: "\u6B63\u5728\u53EA\u8BFB\u627E\u56DE\u5DF2\u63D0\u4EA4\u7684 ChatGPT \u7ED3\u679C\uFF1B\u4E0D\u4F1A\u91CD\u53D1\u63D0\u793A\u8BCD\u3002"
      } : {
        phase: "manual_required",
        reason: "taskd \u672A\u80FD\u91CD\u65B0\u6392\u961F\u539F\u4EFB\u52A1\uFF0C\u65E0\u6CD5\u786E\u8BA4\u5DF2\u63D0\u4EA4\u7684 ChatGPT \u4F1A\u8BDD\u3002"
      };
    } else {
      recovery = {
        phase: "manual_required",
        reason: "\u4EFB\u52A1\u7F3A\u5C11\u53EF\u9A8C\u8BC1\u7684 provider submission marker\uFF0C\u65E0\u6CD5\u5B89\u5168\u627E\u56DE\uFF0C\u4E5F\u4E0D\u4F1A\u91CD\u53D1\u63D0\u793A\u8BCD\u3002"
      };
    }
  }
  await persistTaskSnapshot2(
    env.DB,
    code,
    stored,
    remote ? taskBusinessInput(remote) ?? jsonObject(stored.inputJson) : jsonObject(stored.inputJson),
    remote,
    recovery
  );
  return loadResearchInvestmentAnalysis(env, code);
}
async function prepareResearchInvestmentAnalysis(env, securityCode) {
  const code = normalizeSecurityCode(securityCode);
  const security = await getSecurity(env.DB, code);
  if (!security) throw new Error("security was not found");
  const [marketSnapshot, localProfile] = await Promise.all([
    loadInvestmentAnalysisMarketSnapshot(env, code),
    Promise.resolve(localCompanyProfile(code))
  ]);
  const input = {
    schemaVersion: "investment-analysis-input.v2",
    promptVersion: PROMPT_VERSION,
    preparedAt: (/* @__PURE__ */ new Date()).toISOString(),
    security: { code: security.code, name: security.name, market: security.market, type: security.type, currency: security.currency ?? null },
    marketSnapshot,
    // This local routing state does not inject unlinked business facts for
    // the model to repeat as public disclosure; Web Search must verify them.
    businessBoundary: { status: localProfile ? "confirmed" : "unknown", note: null, products: [], customers: [], regions: [] },
    analysisFramework: localProfile ? frameworkForIndustry(localProfile.industry) : null
  };
  return { securityCode: code, input, prompt: buildResearchInvestmentAnalysisPrompt(input) };
}
function buildResearchInvestmentAnalysisPrompt(input) {
  return RESEARCH_OPERATING_ANALYSIS_PROMPT.replace("{{INPUT_DATA}}", investmentAnalysisBrief(input));
}
async function loadInvestmentAnalysisMarketSnapshot(env, code) {
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const kline = await loadKline(env, code, "day", "normal", `${(/* @__PURE__ */ new Date()).getUTCFullYear() - 1}-01-01`, today);
  const latest = kline.rows.filter((row) => "close" in row).at(-1);
  if (!latest) throw new Error(`Xueqiu K-line is empty for investment analysis: ${code}`);
  return {
    asOf: latest.date,
    source: "xueqiu",
    latestPrice: latest.close,
    marketCapYi: latest.marketCapital === null ? null : latest.marketCapital / 1e8,
    peTtm: latest.peTtm,
    pb: latest.pb,
    psTtm: latest.ps,
    pcfTtm: latest.pcf
  };
}
function localCompanyProfile(code) {
  return eastmoney_company_em2016_profiles_default.profiles.find((profile) => profile.code === code && profile.availability === "available" && profile.industry) ?? null;
}
function frameworkForIndustry(industry) {
  const profile = research_eastmoney_em2016_industry_profiles_default.profiles.find((candidate) => candidate.industries.includes(industry));
  return profile ? {
    primaryFormula: profile.primaryFormula,
    operatingMetrics: [...profile.operatingMetrics],
    valuationMethods: [...profile.valuationMethods],
    stressFactors: [...profile.stressFactors]
  } : null;
}
function investmentAnalysisBrief(input) {
  const market = input.marketSnapshot;
  const framework = input.analysisFramework;
  return [
    "## \u7814\u7A76\u5BF9\u8C61",
    `- \u516C\u53F8\uFF1A${input.security.name}`,
    `- \u8BC1\u5238\u4EE3\u7801\uFF1A${input.security.code}`,
    `- \u62A5\u544A\u65F6\u70B9\uFF1A${input.preparedAt}`,
    "",
    "## \u5DF2\u786E\u8BA4\u7684\u5E02\u573A\u5FEB\u7167",
    `- \u622A\u81F3\uFF1A${market.asOf}`,
    `- \u6570\u636E\u6E90\uFF1A${market.source}`,
    `- \u6700\u65B0\u4EF7\u683C\uFF1A${display(market.latestPrice, input.security.currency ?? void 0)}`,
    `- \u603B\u5E02\u503C\uFF1A${display(market.marketCapYi, "\u4EBF\u5143")}`,
    `- PE\uFF08TTM\uFF09\uFF1A${display(market.peTtm)}`,
    `- PB\uFF1A${display(market.pb)}`,
    `- PS\uFF08TTM\uFF09\uFF1A${display(market.psTtm)}`,
    `- PCF\uFF08TTM\uFF09\uFF1A${display(market.pcfTtm)}`,
    "",
    "## \u7814\u7A76\u6846\u67B6\uFF08\u4E0D\u662F\u516C\u53F8\u4E8B\u5B9E\uFF09",
    `- \u91CF\u4EF7\u6210\u672C\u4E3B\u516C\u5F0F\uFF1A${framework?.primaryFormula ?? "\u672A\u63D0\u4F9B"}`,
    `- \u4F18\u5148\u6838\u9A8C\u6307\u6807\uFF1A${framework?.operatingMetrics.join("\u3001") || "\u672A\u63D0\u4F9B"}`,
    `- \u53EF\u7528\u4F30\u503C\u65B9\u6CD5\uFF1A${framework?.valuationMethods.join("\u3001") || "\u672A\u63D0\u4F9B"}`,
    `- \u538B\u529B\u56E0\u7D20\uFF1A${framework?.stressFactors.join("\u3001") || "\u672A\u63D0\u4F9B"}`
  ].join("\n");
}
function display(value, unit = "") {
  return value === null ? "\u672A\u63D0\u4F9B" : `${Number(value.toFixed(2))}${unit ? ` ${unit}` : ""}`;
}
async function projectResearchInvestmentAnalysis(env, input, task) {
  const result = extractTaskdWebQaResult(task.result);
  validateResearchInvestmentAnalysisTerminalEvidence(result.terminalEvidence);
  const markdown = text5(result.content.markdown);
  validateResearchInvestmentAnalysisMarkdown(markdown);
  const securityCode = text5(object2(input.security)?.code);
  if (!securityCode) throw new Error("investment analysis input has no security code");
  const projectedAt = Date.now();
  const stored = {
    inputJson: JSON.stringify(input),
    markdown,
    citationsJson: JSON.stringify(result.citations),
    sourcesJson: JSON.stringify(result.sources),
    terminalEvidenceJson: JSON.stringify(result.terminalEvidence),
    projectedAt,
    task: taskView2(task),
    recovery: noRecovery()
  };
  await storeResult2(env.DB, securityCode, stored);
  return { securityCode, ...stored };
}
async function loadResult2(db, securityCode) {
  const row = await readStoredResearchInvestmentAnalysis(db, securityCode);
  return row ? { securityCode, ...row } : null;
}
async function readStoredResearchInvestmentAnalysis(db, securityCode) {
  const row = await getKvCache(db, INVESTMENT_ANALYSIS_NAMESPACE, securityCode);
  if (!row) return null;
  const parsed = object2(parseJson2(row.valueJson));
  if (!parsed) return null;
  const task = parseStoredTask2(parsed.task);
  const inputJson = typeof parsed.inputJson === "string" ? parsed.inputJson : null;
  const markdown = text5(parsed.markdown) || null;
  const projectedAt = parsed.projectedAt === null || parsed.projectedAt === void 0 ? null : Number(parsed.projectedAt);
  const recovery = parseRecovery(parsed.recovery);
  if (!markdown && !task && recovery.phase === "none") return null;
  return {
    inputJson,
    markdown,
    citationsJson: jsonString2(parsed.citationsJson, "[]"),
    sourcesJson: jsonString2(parsed.sourcesJson, "[]"),
    terminalEvidenceJson: nullableJsonString2(parsed.terminalEvidenceJson),
    projectedAt: Number.isFinite(projectedAt) ? projectedAt : null,
    task,
    recovery
  };
}
function validateResearchInvestmentAnalysisTerminalEvidence(evidence) {
  if (text5(evidence?.schemaVersion) !== "webqa.completion-evidence.v1" || text5(evidence?.outcome) !== "succeeded") {
    throw new Error("investment analysis taskd result lacks terminal WebQA completion evidence");
  }
}
function validateResearchInvestmentAnalysisMarkdown(markdown) {
  if (markdown.length < 800) throw new Error("investment analysis result is shorter than 800 characters");
  const headings = new Set([...markdown.matchAll(/^# ([1-9]|1[0-2])\. /gm)].map((match2) => match2[1]));
  if (headings.size !== 12) throw new Error("investment analysis result must contain all twelve numbered H1 headings");
}
function taskBusinessInput(task) {
  return object2(object2(task.input)?.business_input);
}
function normalizeReasoningEffort2(value) {
  const normalized = text5(value) || DEFAULT_REASONING_EFFORT2;
  if (!(/* @__PURE__ */ new Set(["low", "medium", "high", "xhigh"])).has(normalized)) throw new Error("unsupported investment-analysis reasoning effort");
  return normalized;
}
function taskView2(task) {
  return { name: task.name, status: task.status, errorMessage: task.errorMessage, createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt };
}
function responseFromStoredResult2(result) {
  const task = result.task;
  const recovery = result.recovery;
  const recoveryAvailable = task?.status === "failed" && recovery.phase === "none";
  return {
    availability: result.markdown ? "available" : task?.status === "failed" ? "failed" : task ? "pending" : "empty",
    task,
    recovery,
    input: parseJson2(result.inputJson),
    report: result.markdown ? {
      markdown: result.markdown,
      citations: parseArray2(result.citationsJson),
      sources: parseArray2(result.sourcesJson),
      terminalMetadata: parseJson2(result.terminalEvidenceJson),
      projectedAt: result.projectedAt
    } : null,
    resume: {
      available: recoveryAvailable,
      reason: recoveryAvailable ? "recover_provider_turn" : recovery.phase === "manual_required" ? "manual_required" : result.markdown ? "already_projected" : "not_failed"
    }
  };
}
async function persistTaskSnapshot2(db, securityCode, current, input, task, recovery = current?.recovery ?? noRecovery()) {
  const stored = mergeStoredResult2(current, {
    inputJson: input ? JSON.stringify(input) : void 0,
    task: task ? taskView2(task) : null,
    recovery
  });
  await storeResult2(db, securityCode, stored);
  return { securityCode, ...stored };
}
async function storeResult2(db, securityCode, value) {
  await putKvCache(db, {
    namespace: INVESTMENT_ANALYSIS_NAMESPACE,
    key: securityCode,
    valueJson: JSON.stringify(value),
    expiresAt: null,
    updatedAt: value.projectedAt ?? value.task?.updatedAt ?? Date.now()
  });
}
function mergeStoredResult2(current, patch) {
  return {
    inputJson: patch.inputJson !== void 0 ? patch.inputJson : current?.inputJson ?? null,
    markdown: patch.markdown !== void 0 ? patch.markdown : current?.markdown ?? null,
    citationsJson: patch.citationsJson ?? current?.citationsJson ?? "[]",
    sourcesJson: patch.sourcesJson ?? current?.sourcesJson ?? "[]",
    terminalEvidenceJson: patch.terminalEvidenceJson !== void 0 ? patch.terminalEvidenceJson : current?.terminalEvidenceJson ?? null,
    projectedAt: patch.projectedAt !== void 0 ? patch.projectedAt : current?.projectedAt ?? null,
    task: patch.task !== void 0 ? patch.task : current?.task ?? null,
    recovery: patch.recovery ?? current?.recovery ?? noRecovery()
  };
}
function noRecovery() {
  return { phase: "none", reason: null };
}
function parseRecovery(value) {
  const recovery = object2(value);
  const phase = text5(recovery?.phase);
  if (phase === "none" || phase === "recovering" || phase === "manual_required") {
    return { phase, reason: text5(recovery?.reason) || null };
  }
  return noRecovery();
}
function hasProviderSubmissionMarker(value) {
  const checkpoint = object2(value);
  const submission = object2(checkpoint?.submission);
  const state = text5(submission?.state) || text5(checkpoint?.submission_state);
  return text5(submission?.schema_version) === "provider_submission.v1" && Boolean(text5(submission?.marker)) && (state === "click_issued" || state === "url_bound");
}
function recoveryAfterTask(current, task) {
  if (current.phase === "recovering" && isTerminalTask2(task)) {
    return {
      phase: "manual_required",
      reason: task.errorMessage || "\u627E\u56DE\u540E\u7684\u4EFB\u52A1\u6CA1\u6709\u4EA7\u751F\u53EF\u9A8C\u8BC1\u7684\u5B8C\u6210\u7ED3\u679C\u3002"
    };
  }
  if (task.status === "failed" && !hasProviderSubmissionMarker(task.checkpoint)) {
    return {
      phase: "manual_required",
      reason: isOutcomeUnknown(task.errorMessage) ? "\u65E0\u6CD5\u786E\u8BA4\u539F\u4F1A\u8BDD\uFF0C\u4E14\u4EFB\u52A1\u6CA1\u6709\u53EF\u9A8C\u8BC1\u7684 provider submission marker\u3002" : "\u4EFB\u52A1\u6CA1\u6709\u53EF\u9A8C\u8BC1\u7684 provider submission marker\uFF0C\u4E0D\u80FD\u6267\u884C\u65E0\u91CD\u653E\u627E\u56DE\u3002"
    };
  }
  return current;
}
function isOutcomeUnknown(value) {
  return /^OutcomeUnknown:/i.test(text5(value));
}
function parseStoredTask2(value) {
  const row = object2(value);
  const name = text5(row?.name);
  const status = text5(row?.status);
  const createdAt = Number(row?.createdAt);
  const updatedAt = Number(row?.updatedAt);
  if (!name || !isTaskStatus2(status) || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return null;
  const completedAt = row?.completedAt === null || row?.completedAt === void 0 ? null : Number(row?.completedAt);
  return {
    name,
    status,
    errorMessage: text5(row?.errorMessage) || null,
    createdAt,
    updatedAt,
    completedAt: Number.isFinite(completedAt) ? completedAt : null
  };
}
function isPendingTask2(task) {
  return task?.status === "queued" || task?.status === "leased" || task?.status === "running" || task?.status === "interrupt_requested";
}
function isTerminalTask2(task) {
  return task?.status === "succeeded" || task?.status === "failed" || task?.status === "interrupted" || task?.status === "superseded";
}
function isTaskStatus2(value) {
  return (/* @__PURE__ */ new Set(["queued", "leased", "running", "interrupt_requested", "succeeded", "failed", "interrupted", "superseded"])).has(value);
}
function object2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function text5(value) {
  return typeof value === "string" ? value.trim() : "";
}
function jsonString2(value, fallback = "{}") {
  return typeof value === "string" ? value : fallback;
}
function nullableJsonString2(value) {
  return typeof value === "string" ? value : null;
}
function parseJson2(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}
function parseArray2(value) {
  const parsed = parseJson2(value);
  return Array.isArray(parsed) ? parsed : [];
}
function jsonObject(value) {
  return object2(parseJson2(value ?? null));
}

// src/modules/research/domain/research-capabilities.ts
function canWriteResearchLocally(env) {
  return env.LLM_RUNTIME === "local";
}

// src/modules/research/api/research.routes.ts
var researchRoutes = new Hono2();
researchRoutes.get("/research/company/:code/investment-analysis", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    return ok(c, await loadResearchInvestmentAnalysis(c.env, code));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});
researchRoutes.get("/research/company/:code/financial-analysis", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    return ok(c, await loadResearchFinancialAnalysis(c.env, code));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});
researchRoutes.post("/research/company/:code/financial-analysis/refresh", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "financial analysis refresh is only available in local LLM runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => ({}));
  try {
    return ok(c, await enqueueResearchFinancialAnalysis(c.env, code, {
      force: body.force !== false,
      reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null
    }));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});
researchRoutes.post("/research/company/:code/financial-analysis/resume", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "financial analysis resume is only available in local LLM runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    return ok(c, await resumeResearchFinancialAnalysis(c.env, code));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});
researchRoutes.post("/research/company/:code/investment-analysis/refresh", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "investment analysis refresh is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => ({}));
  try {
    return ok(c, await enqueueResearchInvestmentAnalysis(c.env, code, {
      reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null
    }));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});
researchRoutes.post("/research/company/:code/investment-analysis/resume", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "investment analysis resume is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    return ok(c, await resumeResearchInvestmentAnalysis(c.env, code));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

// src/modules/research/api/research-investment-analysis.route.test.mjs
test("investment-analysis resume remains unavailable outside the local LLM runtime", async () => {
  const response = await researchRoutes.request(
    "http://example.test/research/company/300308.SZ/investment-analysis/resume",
    { method: "POST" },
    { LLM_RUNTIME: "production" }
  );
  const body = await response.json();
  assert.equal(response.status, 404);
  assert.match(body.msg, /resume is only available in local research runtime/);
});
test("retired research workbench routes are not registered", async () => {
  for (const [path, init] of [
    ["/research/company/300308.SZ/forecasts", {}],
    ["/research/company/300308.SZ/market-structure", {}],
    ["/research/company/300308.SZ/industry-kpi-driver-binding-context", {}],
    ["/research/company/300308.SZ/risk-pressure-scenarios/pressure:1/stress", {}],
    ["/research/company/300308.SZ/valuation-models/dcf", { method: "POST" }],
    ["/research/industry/tracks", { method: "POST" }]
  ]) {
    const response = await researchRoutes.request(`http://example.test${path}`, init);
    assert.equal(response.status, 404, `${init.method || "GET"} ${path} must be absent`);
  }
});
