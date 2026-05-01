/**
 * Loop-guard + wall-clock budget injection for AI-emitted draw
 * source.
 *
 * The AST validator (ast-validator.js) catches dangerous APIs.
 * This module catches dangerous SHAPES: infinite loops and
 * runaway recursion that don't violate the API allowlist but
 * still freeze the iframe.
 *
 * Two enforcement strategies, layered:
 *
 *   1. Wrap the entire source in an instrumented loop that
 *      tracks elapsed time on EVERY iteration of EVERY loop.
 *      Implemented by injecting an `__arenaGuard__()` call into
 *      every for/while/do-while body that throws when called too
 *      many times or when the wall clock exceeds the budget.
 *
 *   2. The sandbox iframe runtime (arena-sandbox.js) monitors
 *      the wall clock from outside and kills the iframe if a
 *      single draw call exceeds the per-call budget by 2x.
 *      That's the catch-net for cases where (1) misses (e.g. a
 *      tight numeric loop with no body to inject into - which
 *      we'd reject at validate time anyway).
 *
 * Strategy in code:
 *
 *   The AST validator already accepted the source. We re-parse
 *   it (cheap) and walk it; for every loop body, we PREPEND a
 *   call to `__arenaGuard__(__arenaGuardCtx__)` where the ctx
 *   is a per-call counter object. The guard helper is provided
 *   by the sandbox runtime as a parameter to the wrapper
 *   function we generate.
 *
 *   For function declarations/expressions inside the body, we
 *   recurse so loops in inner functions also get instrumented.
 *
 *   We don't try to instrument recursion directly. Recursion
 *   that escapes the wall-clock check at entry will be caught
 *   by the iframe-level kill timer. The wall-clock check at
 *   the entry of each outer call also accumulates, so deeply
 *   recursive paths exhaust the budget within one or two frames.
 *
 * Output: a complete ready-to-Function-eval source string that
 * looks like:
 *
 *   function __draw__(__arenaGuardCtx__, ctx, x, y, ...) {
 *     // user source, with __arenaGuard__(__arenaGuardCtx__)
 *     // injected at the top of every loop body
 *   }
 *
 * The sandbox runtime calls this function per frame, passing a
 * fresh guard context that resets the iter counter. The
 * guard context's wall-clock budget is in arena-sandbox.js.
 */

import { parse } from "acorn";

const GUARD_CTX_VAR = "__arenaGuardCtx__";
const GUARD_FN_VAR = "__arenaGuard__";
const GUARD_CALL = `${GUARD_FN_VAR}(${GUARD_CTX_VAR});`;

/**
 * Inject loop-guard calls into a user-provided draw source.
 *
 * @param {string} source           User draw function body, post-validate.
 * @param {string[]} userParams     Names the wrapper accepts (ctx, x, y, t, etc).
 * @returns {{ ok: boolean, source?: string, reason?: string }}
 *   On success: source = a complete `function __draw__(...) { ... }` string
 *   the runtime can pass to `new Function("...source...")`.
 */
export function injectLoopGuard(source, userParams) {
  if (typeof source !== "string") {
    return { ok: false, reason: "source must be a string" };
  }
  const params = Array.isArray(userParams) && userParams.length > 0
    ? userParams
    : ["ctx", "x", "y", "facing", "owner", "t", "random", "state"];

  // Parse the user source, locations:true so we can get
  // start/end offsets to splice into the original text.
  let ast;
  try {
    ast = parse(source, {
      ecmaVersion: 2022,
      sourceType: "script",
      locations: true,
      ranges: true,
    });
  } catch (e) {
    return { ok: false, reason: `parse error: ${e.message}` };
  }

  // Find every loop body's open-brace position.
  const insertPoints = [];
  walk(ast, (node) => {
    if (!node) return;
    if (
      node.type === "ForStatement" ||
      node.type === "ForInStatement" ||
      node.type === "ForOfStatement" ||
      node.type === "WhileStatement" ||
      node.type === "DoWhileStatement"
    ) {
      const body = node.body;
      if (!body) return;
      // BlockStatement: insert just after the opening `{`.
      // Bare statement: wrap in `{ guard; <stmt>; }`.
      if (body.type === "BlockStatement") {
        // After the `{` (range[0]+1).
        insertPoints.push({ at: body.range[0] + 1, kind: "into-block" });
      } else {
        // Wrap: replace from body.range[0] to body.range[1] with
        // `{ <guard>; <originalText>; }`. We record both the start
        // and end so we can splice in two parts.
        insertPoints.push({ at: body.range[0], kind: "wrap-open", endAt: body.range[1] });
      }
    }
  });

  // Sort descending so splicing doesn't invalidate later offsets.
  insertPoints.sort((a, b) => b.at - a.at);

  // Apply edits. We mutate a copy of the source text right-to-left.
  let out = source;
  for (const pt of insertPoints) {
    if (pt.kind === "into-block") {
      out = out.slice(0, pt.at) + " " + GUARD_CALL + " " + out.slice(pt.at);
    } else if (pt.kind === "wrap-open") {
      // Wrap the bare statement. Need to handle endAt FIRST
      // (we're processing right-to-left, so the inner edits
      // happen first). For wrap-open we need both edits at once,
      // and our right-to-left ordering ensures endAt > at means
      // we've already processed any inner edits in [at, endAt).
      const inner = out.slice(pt.at, pt.endAt);
      out = out.slice(0, pt.at) + "{ " + GUARD_CALL + " " + inner + " }" + out.slice(pt.endAt);
    }
  }

  // Wrap the whole thing in a function that takes the guard
  // CONTEXT and the guard FUNCTION as the two leading parameters,
  // followed by the user-facing draw params. Both guard slots are
  // explicit parameters (not closures) because the iframe runtime
  // evaluates the function source via `new Function(...)`, which
  // breaks any closure over the runtime's guard helpers. The
  // runtime calls the result with (guardCtx, guardFn, ...userArgs).
  const fnSource = `function __draw__(${GUARD_CTX_VAR}, ${GUARD_FN_VAR}, ${params.join(", ")}) {\n${out}\n}`;

  return { ok: true, source: fnSource };
}

// ── AST walker (same shape as ast-validator's) ────────────

function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === "object" && typeof child.type === "string") walk(child, visit);
      }
    } else if (val && typeof val === "object" && typeof val.type === "string") {
      walk(val, visit);
    }
  }
}
