/**
 * AST validator for AI-emitted canvas draw functions.
 *
 * Every draw the AI writes is a Function body string we'd normally
 * pass to `new Function(...)`. Before we let that happen, the body
 * has to clear THIS validator: parse it with acorn, walk every
 * Identifier and MemberExpression, reject if anything matches the
 * banlist or anything UNKNOWN appears that isn't on the allowlist.
 *
 * Reject-by-default: if the AI emits something we didn't plan for,
 * the answer is no. This is the security boundary; lenience here
 * is what lets a sandbox escape happen.
 *
 * Threat model + allowlist details: see DESIGN_SHIP_3.md.
 *
 * Returns:
 *   { ok: true } on accept
 *   { ok: false, reason: string, line?: number, col?: number } on reject
 *
 * The validator is pure: it doesn't execute the code, doesn't open
 * an iframe, doesn't touch the network. Safe to call on the main
 * thread per draw.
 */

import { parse } from "acorn";

// ── Allowlists ─────────────────────────────────────────────

/**
 * Identifiers that are ALLOWED as bare references (e.g. `Math`,
 * `Array`, `JSON`, parameters passed to the draw function).
 *
 * Things NOT here that you might expect: `console`, `Date`,
 * `crypto`, `Image`. Those are deliberately excluded.
 */
const ALLOWED_GLOBAL_IDENTIFIERS = new Set([
  // Math
  "Math",
  // Number / String / Boolean primitive constructors
  "Number", "String", "Boolean",
  // Array (only the .from / .isArray / .of statics are useful;
  // the new Array() constructor is allowed but its size is capped
  // by allocation guards inserted by the loop-guard pass).
  "Array",
  // Object (only .keys / .values / .entries / .freeze are useful)
  "Object",
  // JSON
  "JSON",
  // Standard parsers + checkers
  "parseInt", "parseFloat", "isNaN", "isFinite",
  // Constants
  "Infinity", "NaN", "undefined", "null", "true", "false",
  // performance.now is allowed via the MemberExpression check
  "performance",
]);

/**
 * Identifiers passed as DRAW FUNCTION PARAMETERS. These are also
 * permitted as bare references inside the function body. The
 * sandbox runtime guarantees these names; the AI can rely on them.
 *
 * Slot draws receive: ctx, x, y, facing, owner, t, random, state
 * Projectile draws receive: ctx, p (which has .x, .y, .progress, etc)
 * Overlay draws receive: ctx, scene
 * Brain hooks receive: self, world, dt
 *
 * Union of all signatures so the validator can accept any draw kind
 * without the caller having to specify which.
 */
const ALLOWED_PARAM_IDENTIFIERS = new Set([
  "ctx", "x", "y", "facing", "owner", "t", "random", "state",
  "p", "scene", "self", "world", "dt",
]);

/**
 * Permitted member-access paths. The validator walks every
 * MemberExpression and confirms the FULL chain is on this list.
 * E.g. `Math.PI` matches; `Math.constructor` doesn't.
 *
 * Format: each entry is the dot-path. Computed access (`a[b]`) is
 * checked separately - we only allow numeric/string-literal indices
 * and only into known shapes.
 */
const ALLOWED_MEMBER_PATHS = new Set([
  // Math
  "Math.PI", "Math.E",
  "Math.abs", "Math.floor", "Math.ceil", "Math.round", "Math.sign", "Math.trunc",
  "Math.min", "Math.max", "Math.pow", "Math.sqrt", "Math.cbrt", "Math.hypot",
  "Math.sin", "Math.cos", "Math.tan", "Math.asin", "Math.acos", "Math.atan", "Math.atan2",
  "Math.log", "Math.log2", "Math.log10", "Math.exp",
  "Math.random",   // shadowed at runtime to seed-route, see PRNG module
  // Number statics + numeric constants
  "Number.isFinite", "Number.isInteger",
  "Number.MAX_SAFE_INTEGER", "Number.MIN_SAFE_INTEGER",
  "Number.MAX_VALUE", "Number.MIN_VALUE",
  // Array statics
  "Array.from", "Array.isArray", "Array.of",
  // Object statics
  "Object.keys", "Object.values", "Object.entries", "Object.freeze",
  // JSON
  "JSON.stringify", "JSON.parse",
  // performance
  "performance.now",
  // Owner shape (passed as a parameter)
  "owner.type", "owner.color",
  // Projectile shape
  "p.x", "p.y", "p.progress",
  "p.fromX", "p.fromY", "p.toX", "p.toY",
  "p.age", "p.ttl", "p.ageMs", "p.ttlMs",
  // Scene shape (overlay draws)
  "scene.width", "scene.height",
  "scene.marks", "scene.lastCast", "scene.t",
  // Brain (cosmetic)
  "self.type", "self.color", "self.square",
  "self.x", "self.y", "self.facing",
  "world.spawnEffect", "world.spawnProjectile",
]);

/**
 * Permitted ctx properties (mostly the canvas 2D API). The
 * validator treats `ctx.<anything>` specially: only properties
 * in this set are accepted.
 */
const ALLOWED_CTX_MEMBERS = new Set([
  // State setters
  "fillStyle", "strokeStyle", "lineWidth", "lineCap", "lineJoin", "miterLimit",
  "globalAlpha", "globalCompositeOperation",
  "shadowColor", "shadowBlur", "shadowOffsetX", "shadowOffsetY",
  // Drawing methods
  "fillRect", "clearRect", "strokeRect",
  "beginPath", "closePath", "moveTo", "lineTo", "bezierCurveTo", "quadraticCurveTo",
  "arc", "arcTo", "ellipse", "rect", "roundRect",
  "fill", "stroke",
  "save", "restore",
  // Transforms
  "translate", "rotate", "scale", "transform", "setTransform", "resetTransform",
  // Gradients / patterns
  "createLinearGradient", "createRadialGradient", "createConicGradient",
]);

/**
 * Permitted methods on a gradient object returned by
 * createLinearGradient / createRadialGradient / createConicGradient.
 * Tracked separately because we don't generally allow arbitrary
 * member access; gradients need .addColorStop and that's it.
 */
const ALLOWED_GRADIENT_METHODS = new Set([
  "addColorStop",
]);

// ── Banlists (everything matching here rejects, even if it
// would otherwise be on the allowlist somehow). The banlist is
// belt-and-suspenders: if we ever loosen the allowlist by
// mistake, the banlist still catches the dangerous tokens.

const BANNED_IDENTIFIERS = new Set([
  // Network / external IO
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "navigator",
  "Image", "Audio", "Video", "Worker", "SharedWorker", "ServiceWorker",
  "MessageChannel", "BroadcastChannel",
  // Code execution
  "eval", "Function", "AsyncFunction", "GeneratorFunction",
  // Globals to the parent
  "document", "window", "globalThis", "parent", "top",
  // Storage
  "localStorage", "sessionStorage", "indexedDB", "caches",
  // Time / scheduling
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame",
  "requestIdleCallback", "cancelIdleCallback",
  "queueMicrotask",
  // Crypto / wasm
  "crypto", "WebAssembly",
  // Replay-unfriendly
  "Date",
  // Module / commonjs
  "import", "require", "module", "exports", "process",
  // Reflect / Proxy escape
  "Reflect", "Proxy",
  // Symbol can be used to bypass property allowlists via @@iterator
  // tricks; ban for now.
  "Symbol",
  // Generic identifiers used for prototype escape
  "constructor", "__proto__", "prototype",
]);

/**
 * Banned member names anywhere in a MemberExpression. This applies
 * to ALL objects, not just ctx. So `someThing.constructor` rejects.
 */
const BANNED_MEMBER_NAMES = new Set([
  "constructor", "__proto__", "prototype",
  "fillText", "strokeText", "drawImage",
  "measureText",
  "createImageData", "getImageData", "putImageData",
  "toDataURL", "toBlob",
  "captureStream", "transferControlToOffscreen",
  // Image loading via createPattern + Image constructor pattern
  "createPattern",
]);

// ── Public API ─────────────────────────────────────────────

/**
 * Validate a draw function body string. The body is what would be
 * passed to `new Function(args, body)` - the function header is
 * not included.
 *
 * @param {string} source       JS function body. Should be parseable
 *                              as a list of statements.
 * @param {Object} [opts]
 * @param {string[]} [opts.params]  Parameter names the runtime will
 *                                  bind. Defaults to the union of all
 *                                  draw signatures.
 * @returns {{ ok: boolean, reason?: string, line?: number, col?: number }}
 */
export function validateDraw(source, opts = {}) {
  if (typeof source !== "string") {
    return { ok: false, reason: "draw source must be a string" };
  }
  if (source.length > 8192) {
    return { ok: false, reason: `draw source is too long (${source.length} chars; cap 8192)` };
  }

  // Wrap the body in a thin function so acorn parses it as a
  // function body (allows return statements, await is forbidden
  // anyway). Use a unique parameter list so the AST shows them
  // as locals (excluded from the bare-reference check).
  const paramList = (opts.params || [...ALLOWED_PARAM_IDENTIFIERS]).join(", ");
  const wrapped = `function __draw__(${paramList}) {\n${source}\n}`;

  let ast;
  try {
    ast = parse(wrapped, {
      ecmaVersion: 2022,
      sourceType: "script",
      locations: true,
      // No top-level await, no module syntax. We're in a Function
      // body, not a module.
      allowAwaitOutsideFunction: false,
      allowReturnOutsideFunction: false,
      allowImportExportEverywhere: false,
    });
  } catch (e) {
    return { ok: false, reason: `parse error: ${e.message}` };
  }

  // Build a set of locals the user is allowed to reference. The
  // params bind into scope; any other Identifier MUST be on the
  // allowlist.
  const locals = new Set([...ALLOWED_PARAM_IDENTIFIERS]);

  let result = { ok: true };

  walk(ast, (node, parent) => {
    if (!result.ok) return false;

    // ── Forbid syntax constructs that bypass the validator ──
    // Tagged templates: `something\`x\`` calls the tag; the
    // `something` part might be a banned function. Easier to ban
    // the syntax than to special-case it.
    if (node.type === "TaggedTemplateExpression") {
      result = reject(node, "tagged template literals are not allowed");
      return false;
    }
    // `with` statements bypass any name-resolution analysis.
    if (node.type === "WithStatement") {
      result = reject(node, "with-statements are not allowed");
      return false;
    }
    // try/catch is allowed but the catch-binding must not shadow
    // an allowlisted identifier (an attacker could `try{}catch(eval){...}`
    // and then `eval(...)` would refer to the catch-binding, not the
    // global). We disallow catch bindings entirely - cleaner than
    // trying to track shadowing. Optional catch (`catch {}`) is fine.
    if (node.type === "CatchClause" && node.param) {
      result = reject(node, "catch bindings are not allowed (use `catch {}` if you must catch)");
      return false;
    }
    // Async / await / generators / classes / dynamic import are
    // out of scope for the draw API and frequently used in
    // sandbox-escape patterns.
    if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "FunctionDeclaration") {
      if (node.async) {
        result = reject(node, "async functions are not allowed");
        return false;
      }
      if (node.generator) {
        result = reject(node, "generator functions are not allowed");
        return false;
      }
    }
    if (node.type === "AwaitExpression") {
      result = reject(node, "await is not allowed");
      return false;
    }
    if (node.type === "YieldExpression") {
      result = reject(node, "yield is not allowed");
      return false;
    }
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      result = reject(node, "classes are not allowed");
      return false;
    }
    if (node.type === "ImportExpression" || node.type === "ImportDeclaration") {
      result = reject(node, "import is not allowed");
      return false;
    }
    if (node.type === "MetaProperty") {
      // `import.meta`, `new.target`. Both bypass the validator.
      result = reject(node, "meta properties are not allowed");
      return false;
    }
    if (node.type === "ThisExpression") {
      // `this` inside a function expression bound to anything
      // gives access to whatever the runtime binds it to. The
      // sandbox runtime calls our wrapper function with no
      // explicit this, so `this` is undefined in strict mode -
      // but we ban it anyway for clarity.
      result = reject(node, "this is not allowed (the sandbox does not bind it)");
      return false;
    }
    // Object literals with computed keys can hide banned
    // identifiers as prototype-escape gadgets (e.g.
    // `{ [Symbol.iterator]: ... }`). Allow only string/numeric
    // literal keys and shorthand identifiers.
    if (node.type === "Property" && node.computed) {
      result = reject(node, "computed object keys are not allowed");
      return false;
    }

    // ── Track locally-declared identifiers ──
    // VariableDeclarator: `let x = ...` adds `x` to locals.
    // FunctionDeclaration adds the function name. ArrowFunction /
    // FunctionExpression params add their params. We walk top-down
    // so by the time we see Identifier references, the declarations
    // are already in `locals`.
    if (node.type === "VariableDeclarator") {
      collectPatternIds(node.id, locals);
    }
    if (node.type === "FunctionDeclaration") {
      if (node.id?.name) locals.add(node.id.name);
      for (const param of node.params || []) collectPatternIds(param, locals);
    }
    if ((node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") && node !== ast.body[0]) {
      for (const param of node.params || []) collectPatternIds(param, locals);
    }

    // ── Check Identifier references ──
    if (node.type === "Identifier") {
      // Identifiers can appear in many places; we only want to
      // check ACTUAL references (not e.g. property names in
      // member expressions or property keys).
      if (isReferenceContext(node, parent)) {
        const name = node.name;
        // Short-circuit pattern: locals always pass.
        if (locals.has(name)) return;
        // Bare allowlist hit?
        if (ALLOWED_GLOBAL_IDENTIFIERS.has(name)) return;
        // Banlist hit?
        if (BANNED_IDENTIFIERS.has(name)) {
          result = reject(node, `identifier '${name}' is banned`);
          return false;
        }
        // Unknown bare identifier - reject by default.
        result = reject(node, `identifier '${name}' is not in the allowlist`);
        return false;
      }
    }

    // ── Check MemberExpression chains ──
    if (node.type === "MemberExpression") {
      // Block computed access UNLESS it's a numeric / string
      // literal index (e.g. `arr[0]` or `obj["x"]`). Anything
      // dynamic could fetch a banned property.
      if (node.computed) {
        const prop = node.property;
        const isLiteralIndex = prop.type === "Literal" &&
          (typeof prop.value === "number" || typeof prop.value === "string");
        if (!isLiteralIndex) {
          result = reject(node, "dynamic property access (a[b]) is not allowed; use a.b for known keys");
          return false;
        }
        // Even literal-string indices have to dodge banned member
        // names (so a["constructor"] is rejected).
        if (typeof prop.value === "string" && BANNED_MEMBER_NAMES.has(prop.value)) {
          result = reject(node, `member '${prop.value}' is banned`);
          return false;
        }
      } else {
        // Non-computed: the property name is an Identifier.
        const propName = node.property.name;
        if (BANNED_MEMBER_NAMES.has(propName)) {
          result = reject(node, `member '${propName}' is banned`);
          return false;
        }
        // Validate ctx.<member> against the canvas API allowlist.
        if (isCtxAccess(node)) {
          if (!ALLOWED_CTX_MEMBERS.has(propName)) {
            result = reject(node, `ctx.${propName} is not in the canvas API allowlist`);
            return false;
          }
        }
        // Validate the full chain when it's a known global root.
        const path = chainPath(node);
        if (path && (path.startsWith("Math.") || path.startsWith("Number.") ||
                     path.startsWith("Array.") || path.startsWith("Object.") ||
                     path.startsWith("JSON.") || path.startsWith("performance."))) {
          if (!ALLOWED_MEMBER_PATHS.has(path)) {
            result = reject(node, `${path} is not on the allowlist`);
            return false;
          }
        }
      }
    }

    // ── Check call expressions for banned shapes ──
    if (node.type === "NewExpression") {
      const callee = node.callee;
      if (callee.type === "Identifier") {
        if (BANNED_IDENTIFIERS.has(callee.name)) {
          result = reject(node, `new ${callee.name} is banned`);
          return false;
        }
        // Allow `new Array(N)` only when N is a literal <= 4096.
        // Big-array allocation is the cheapest way to OOM the
        // sandbox.
        if (callee.name === "Array") {
          const arg = node.arguments[0];
          if (arg && arg.type === "Literal" && typeof arg.value === "number" && arg.value > 4096) {
            result = reject(node, `new Array(${arg.value}) exceeds the 4096 element cap`);
            return false;
          }
        }
      }
    }
    return undefined;
  });

  return result;
}

// ── Internal helpers ──────────────────────────────────────

/**
 * Generic AST walker. Calls `visit(node, parent)` on every node;
 * stops descent when visit returns false.
 */
function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  const ret = visit(node, parent);
  if (ret === false) return;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === "object" && typeof child.type === "string") {
          walk(child, visit, node);
        }
      }
    } else if (val && typeof val === "object" && typeof val.type === "string") {
      walk(val, visit, node);
    }
  }
}

/**
 * True iff the Identifier node represents an actual reference
 * (variable use), not a property name or destructure key.
 *
 * Examples:
 *   - `foo` in `foo.bar` is a reference (parent.object === node).
 *   - `bar` in `foo.bar` is NOT a reference (parent.property === node, !computed).
 *   - `foo` in `let foo = 1` is a binding, not a reference.
 *   - `foo` in `function (foo) {}` is a binding.
 */
function isReferenceContext(node, parent) {
  if (!parent) return true;
  // Property name in a non-computed MemberExpression.
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) {
    return false;
  }
  // Property key in an object literal / pattern.
  if ((parent.type === "Property" || parent.type === "ObjectProperty") && parent.key === node && !parent.computed) {
    return false;
  }
  // Method definition key.
  if (parent.type === "MethodDefinition" && parent.key === node && !parent.computed) {
    return false;
  }
  // Variable declarator id.
  if (parent.type === "VariableDeclarator" && parent.id === node) return false;
  // Function declaration / expression name.
  if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression") && parent.id === node) return false;
  // Function param.
  if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ArrowFunctionExpression") && (parent.params || []).includes(node)) {
    return false;
  }
  // Catch param.
  if (parent.type === "CatchClause" && parent.param === node) return false;
  // Labeled statement label.
  if (parent.type === "LabeledStatement" && parent.label === node) return false;
  // Break / continue labels.
  if ((parent.type === "BreakStatement" || parent.type === "ContinueStatement") && parent.label === node) return false;
  return true;
}

/**
 * True iff the MemberExpression's object is the `ctx` parameter.
 * Walks ALL nested member chains to find the root identifier.
 */
function isCtxAccess(node) {
  let cur = node.object;
  while (cur && cur.type === "MemberExpression") cur = cur.object;
  return cur && cur.type === "Identifier" && cur.name === "ctx";
}

/**
 * If the MemberExpression is a clean dotted chain (`Math.PI`,
 * `JSON.stringify`, `Number.isFinite`), return the dot-path string.
 * Returns null if any segment is computed.
 */
function chainPath(node) {
  const parts = [];
  let cur = node;
  while (cur && cur.type === "MemberExpression") {
    if (cur.computed) return null;
    parts.unshift(cur.property.name);
    cur = cur.object;
  }
  if (!cur || cur.type !== "Identifier") return null;
  parts.unshift(cur.name);
  return parts.join(".");
}

/**
 * Recursively collect identifier names declared by a destructuring
 * pattern (or simple Identifier).
 */
function collectPatternIds(node, into) {
  if (!node) return;
  if (node.type === "Identifier") {
    into.add(node.name);
    return;
  }
  if (node.type === "ObjectPattern") {
    for (const prop of node.properties || []) {
      if (prop.type === "Property") collectPatternIds(prop.value, into);
      else if (prop.type === "RestElement") collectPatternIds(prop.argument, into);
    }
    return;
  }
  if (node.type === "ArrayPattern") {
    for (const el of node.elements || []) {
      if (el) collectPatternIds(el, into);
    }
    return;
  }
  if (node.type === "AssignmentPattern") {
    collectPatternIds(node.left, into);
    return;
  }
  if (node.type === "RestElement") {
    collectPatternIds(node.argument, into);
    return;
  }
}

function reject(node, reason) {
  return {
    ok: false,
    reason,
    line: node.loc?.start.line,
    col: node.loc?.start.column,
  };
}
