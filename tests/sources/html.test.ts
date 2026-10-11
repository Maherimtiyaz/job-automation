import assert from "node:assert/strict";
import { test } from "node:test";
import { collapseWhitespace, stripHtmlToText } from "../../src/sources/html.js";

test("stripHtmlToText removes tags and decodes entities", () => {
  assert.equal(stripHtmlToText("<p>Hello <b>world</b></p>"), "Hello world");
  assert.equal(stripHtmlToText("A &amp; B &lt; C &gt; D"), "A & B < C > D");
  assert.equal(stripHtmlToText('"quoted" &quot;again&quot;'), '"quoted" "again"');
});

test("stripHtmlToText handles double-encoded Greenhouse content", () => {
  const raw =
    "&amp;lt;p&amp;gt;Backend Engineer Intern&amp;lt;/p&amp;gt;" +
    "&amp;lt;ul&amp;gt;&amp;lt;li&amp;gt;Node.js &amp;amp; SQL&amp;lt;/li&amp;gt;&amp;lt;/ul&amp;gt;";
  const text = stripHtmlToText(raw);
  assert.equal(text, "Backend Engineer Intern Node.js & SQL");
});

test("stripHtmlToText removes script and style blocks", () => {
  const raw =
    "<style>.hidden { display: none }</style><div>Title</div><script>alert(1)</script>";
  assert.equal(stripHtmlToText(raw), "Title");
});

test("stripHtmlToText collapses whitespace", () => {
  assert.equal(stripHtmlToText("<div>  Line  one\n\n   Line two  </div>"), "Line one Line two");
});

test("collapseWhitespace trims and single-spaces", () => {
  assert.equal(collapseWhitespace("  a\t\tb\n\n  c  "), "a b c");
});