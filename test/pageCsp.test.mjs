// The page tab's Content-Security-Policy is assembled from the resolved frame
// origin, and that origin comes from a saved entry's URL by way of
// asExternalUri — `${ext.scheme}://${ext.authority}`, with vscode.Uri keeping
// an authority's characters verbatim. It lands inside content="…", one
// attribute away from the escapeAttr the sibling src="…" already gets.
//
// The CSP attribute is the worst possible injection point in this file: an
// unescaped quote does not merely add markup, it truncates the very policy
// that would have contained the markup, so `script-src 'nonce-…'` stops
// applying to the document it was supposed to govern.
import { load } from './bundle.mjs';

export default async function ({ ok }) {
  const { renderPageHtml } = await load('pagePanel.ts');

  // The payload closes the attribute and the tag, then supplies a policy of
  // its own. A browser honours the FIRST Content-Security-Policy meta it
  // parses, so an injected one placed ahead of ours is the whole attack.
  const injected = `"><meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline'"><x y="`;
  const html = renderPageHtml('http://example.test/', `http://evil${injected}`);

  ok(
    !html.includes(injected),
    'a quote in the frame origin cannot close the CSP attribute and inject markup'
  );
  ok(
    /content="[^"]*&quot;[^"]*"/.test(html),
    'the frame origin is attribute-escaped inside the CSP, not interpolated raw'
  );
  ok(
    (html.match(/http-equiv="Content-Security-Policy"/g) || []).length === 1,
    'exactly one CSP meta tag survives — an injected second one would win by being first'
  );

  // The ordinary case must still produce a usable policy: escaping that broke
  // frame-src would silently blank every page tab instead of framing it.
  const plain = renderPageHtml('http://example.test/app', 'http://example.test');
  ok(
    plain.includes('frame-src http://example.test;'),
    'an ordinary origin still reaches frame-src unchanged'
  );
}
