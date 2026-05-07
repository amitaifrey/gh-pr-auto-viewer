// Minimatch-subset glob matcher. No deps, browser-safe.
// Supports: *, **, ?, [abc], [a-z], {a,b}, leading !negation, # comments.
(function () {
  const cache = new Map();

  function compile(pattern) {
    if (cache.has(pattern)) return cache.get(pattern);
    let re = '^';
    let i = 0;
    const n = pattern.length;
    while (i < n) {
      const c = pattern[i];
      if (c === '*') {
        if (pattern[i + 1] === '*') {
          // ** — match across path separators
          const before = pattern[i - 1];
          const after = pattern[i + 2];
          if ((before === '/' || before === undefined) && after === '/') {
            // `**/` or leading `**/` — zero or more path segments
            re += '(?:.*\\/)?';
            i += 3;
            continue;
          }
          if ((before === '/' || before === undefined) && after === undefined) {
            // trailing `/**` or lone `**`
            re += '.*';
            i += 2;
            continue;
          }
          // `**` in the middle of a segment — treat like `.*`
          re += '.*';
          i += 2;
          continue;
        }
        re += '[^/]*';
        i++;
        continue;
      }
      if (c === '?') {
        re += '[^/]';
        i++;
        continue;
      }
      if (c === '[') {
        // character class — find matching ]
        let j = i + 1;
        if (pattern[j] === '!' || pattern[j] === '^') j++;
        if (pattern[j] === ']') j++;
        while (j < n && pattern[j] !== ']') j++;
        if (j >= n) {
          // unmatched [ — treat as literal
          re += '\\[';
          i++;
          continue;
        }
        let cls = pattern.slice(i + 1, j);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls + ']';
        i = j + 1;
        continue;
      }
      if (c === '{') {
        // alternation — find matching }
        let depth = 1;
        let j = i + 1;
        while (j < n && depth > 0) {
          if (pattern[j] === '{') depth++;
          else if (pattern[j] === '}') depth--;
          if (depth > 0) j++;
        }
        if (depth !== 0) {
          re += '\\{';
          i++;
          continue;
        }
        const inner = pattern.slice(i + 1, j);
        const parts = splitTopLevel(inner, ',').map((p) => {
          // recursively compile each alt as a sub-pattern body
          return compile(p).source.replace(/^\^|\$$/g, '');
        });
        re += '(?:' + parts.join('|') + ')';
        i = j + 1;
        continue;
      }
      // literal — escape regex specials
      if (/[.+^$()|\\]/.test(c)) re += '\\' + c;
      else re += c;
      i++;
    }
    re += '$';
    const compiled = new RegExp(re);
    cache.set(pattern, compiled);
    return compiled;
  }

  function splitTopLevel(s, sep) {
    const out = [];
    let depth = 0;
    let last = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (c === sep && depth === 0) {
        out.push(s.slice(last, i));
        last = i + 1;
      }
    }
    out.push(s.slice(last));
    return out;
  }

  function matchAny(path, patterns) {
    let matched = false;
    for (const raw of patterns) {
      if (!raw) continue;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const negate = trimmed.startsWith('!');
      const body = negate ? trimmed.slice(1) : trimmed;
      let re;
      try {
        re = compile(body);
      } catch (_) {
        continue;
      }
      if (re.test(path)) matched = !negate;
    }
    return matched;
  }

  const api = { compile, matchAny };
  if (typeof window !== 'undefined') window.GReadGlob = api;
  if (typeof self !== 'undefined') self.GReadGlob = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
