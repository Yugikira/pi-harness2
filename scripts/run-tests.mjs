#!/usr/bin/env node
/**
 * Zero-dependency test runner for `pi-harness2`.
 * Strips TypeScript declarations and annotations from `src/*.ts` and `test/*.test.ts`
 * while preserving all strings, regexes, and object literals, then executes `node --test`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const tmpBuildDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness2-build-"));

function stripBalancedBracesBlock(code, startSearchRegex) {
  let result = code;
  while (true) {
    const match = startSearchRegex.exec(result);
    if (!match) break;
    const startIdx = match.index;
    const openBraceIdx = result.indexOf("{", startIdx + match[0].length - 1);
    if (openBraceIdx === -1) break;
    let depth = 0;
    let endIdx = openBraceIdx;
    for (; endIdx < result.length; endIdx++) {
      if (result[endIdx] === "{") depth++;
      else if (result[endIdx] === "}") {
        depth--;
        if (depth === 0) {
          endIdx++;
          break;
        }
      }
    }
    result = result.slice(0, startIdx) + result.slice(endIdx);
  }
  return result;
}

function stripGenericConstructorCalls(code) {
  let result = code;
  const re = /\bnew\s+(Map|Set|Array)\s*</g;
  let offset = 0;
  while (true) {
    re.lastIndex = offset;
    const m = re.exec(result);
    if (!m) break;
    const openAngle = m.index + m[0].length - 1;
    let depth = 0;
    let i = openAngle;
    for (; i < result.length; i++) {
      if (result[i] === "<") depth++;
      else if (result[i] === ">" && result[i - 1] !== "=") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    result = result.slice(0, openAngle) + result.slice(i);
    offset = openAngle + 1;
  }
  return result;
}

function stripParamTypesInParenList(paramListStr) {
  const params = [];
  let current = "";
  let angle = 0, brace = 0, bracket = 0, paren = 0;
  for (let i = 0; i < paramListStr.length; i++) {
    const ch = paramListStr[i];
    if (ch === "<") angle++;
    else if (ch === ">" && paramListStr[i - 1] !== "=") angle = Math.max(0, angle - 1);
    else if (ch === "{") brace++;
    else if (ch === "}") brace = Math.max(0, brace - 1);
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);

    if (ch === "," && angle === 0 && brace === 0 && bracket === 0 && paren === 0) {
      params.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) params.push(current);

  const cleaned = params.map((p) => {
    const m = p.match(/^(\s*(?:\.\.\.)?[A-Za-z0-9_]+)\??\s*:\s*([\s\S]+)$/);
    if (!m) return p;
    const namePart = m[1];
    const rest = m[2];
    let a = 0, b = 0, k = 0, pr = 0;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c === "<") a++;
      else if (c === ">" && rest[i - 1] !== "=") a = Math.max(0, a - 1);
      else if (c === "{") b++;
      else if (c === "}") b = Math.max(0, b - 1);
      else if (c === "[") k++;
      else if (c === "]") k = Math.max(0, k - 1);
      else if (c === "(") pr++;
      else if (c === ")") pr = Math.max(0, pr - 1);
      else if (c === "=" && rest[i + 1] !== ">" && a === 0 && b === 0 && k === 0 && pr === 0) {
        return `${namePart} = ${rest.slice(i + 1).trim()}`;
      }
    }
    return namePart;
  });

  return cleaned.join(", ");
}

function stripFunctionSignatures(code) {
  let out = "";
  let i = 0;
  const fnHeaderRe = /\b(?:(?:async\s+)?function(?:\s+[A-Za-z0-9_]+)?|constructor)\s*\(|(?:\basync\s*)?\([^()\n]*\)\s*(?::\s*[^=\n]+)?=>/g;

  while (i < code.length) {
    fnHeaderRe.lastIndex = i;
    const m = fnHeaderRe.exec(code);
    if (!m) {
      out += code.slice(i);
      break;
    }

    const matchStart = m.index;
    out += code.slice(i, matchStart);

    const openParen = code.indexOf("(", matchStart);
    let depth = 0;
    let closeParen = openParen;
    for (; closeParen < code.length; closeParen++) {
      if (code[closeParen] === "(") depth++;
      else if (code[closeParen] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }

    const prefix = code.slice(matchStart, openParen + 1);
    const paramInner = code.slice(openParen + 1, closeParen);
    const cleanedParams = stripParamTypesInParenList(paramInner);

    let afterClose = closeParen + 1;
    while (afterClose < code.length && /\s/.test(code[afterClose])) afterClose++;

    if (code[afterClose] === ":") {
      let cursor = afterClose + 1;
      let angle = 0, brace = 0, bracket = 0;
      while (cursor < code.length) {
        const ch = code[cursor];
        if (ch === "<") angle++;
        else if (ch === ">" && code[cursor - 1] !== "=") angle = Math.max(0, angle - 1);
        else if (ch === "[") bracket++;
        else if (ch === "]") bracket = Math.max(0, bracket - 1);
        else if (ch === "{") {
          if (angle === 0 && bracket === 0 && brace === 0) {
            let tempEnd = cursor;
            let d = 0;
            for (; tempEnd < code.length; tempEnd++) {
              if (code[tempEnd] === "{") d++;
              else if (code[tempEnd] === "}") {
                d--;
                if (d === 0) {
                  tempEnd++;
                  break;
                }
              }
            }
            const afterObj = code.slice(tempEnd).match(/^\s*\{/);
            if (afterObj) {
              cursor = tempEnd;
              continue;
            } else {
              break;
            }
          }
          brace++;
        } else if (ch === "}") {
          brace = Math.max(0, brace - 1);
        } else if (
          ch === "=" &&
          code[cursor + 1] === ">" &&
          angle === 0 &&
          brace === 0 &&
          bracket === 0
        ) {
          break;
        }
        cursor++;
      }
      out += `${prefix}${cleanedParams}) `;
      i = cursor;
    } else {
      out += `${prefix}${cleanedParams})`;
      i = closeParen + 1;
    }
  }
  return out;
}

function stripTypeScriptTypes(source) {
  let code = source.replace(/^\s*import\s+type\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
  code = stripBalancedBracesBlock(code, /(?:export\s+)?interface\s+[A-Za-z0-9_]+\s*\{/);
  code = code.replace(/^\s*export\s+type\s+[A-Za-z0-9_]+\s*=[\s\S]*?;\s*$/gm, "");
  code = stripGenericConstructorCalls(code);
  code = stripFunctionSignatures(code);
  code = code.replace(/^(\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z0-9_]+)\s*:\s*[^\n=]+?(\s*=|\s*;\s*$)/gm, "$1$2");
  code = code.replace(/\s+as\s+[A-Za-z0-9_]+(?:<[^>;)\n]+>)?(?:\[\])?(?:\["[A-Za-z0-9_]+"])?(?=[,;)\]\n])/g, "");
  code = code.replace(/([A-Za-z0-9_)\]])!(?=[.,;)\]\s])/g, "$1");
  return code;
}

function copyAndTranspileDir(relDir) {
  const srcDir = path.join(rootDir, relDir);
  const outDir = path.join(tmpBuildDir, relDir);
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    const fullSrc = path.join(srcDir, entry);
    if (fs.statSync(fullSrc).isDirectory()) {
      copyAndTranspileDir(path.join(relDir, entry));
    } else if (entry.endsWith(".ts")) {
      const raw = fs.readFileSync(fullSrc, "utf-8");
      const jsCode = stripTypeScriptTypes(raw);
      const outName = entry.replace(/\.ts$/, ".js");
      fs.writeFileSync(path.join(outDir, outName), jsCode, "utf-8");
    } else {
      fs.copyFileSync(fullSrc, path.join(outDir, entry));
    }
  }
}

copyAndTranspileDir("src");
copyAndTranspileDir("test");
fs.writeFileSync(
  path.join(tmpBuildDir, "package.json"),
  JSON.stringify({ type: "module" }),
  "utf-8"
);

const testFile = path.join(tmpBuildDir, "test", "harness2.test.js");
const res = spawnSync(process.execPath, ["--test", testFile], {
  stdio: "inherit",
});

fs.rmSync(tmpBuildDir, { recursive: true, force: true });
process.exit(res.status ?? 1);
