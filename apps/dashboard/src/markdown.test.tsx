import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageMarkdown } from './MessageMarkdown';
it('renders supported markdown as semantic elements with safe external links',()=>{
 const html=renderToStaticMarkup(<MessageMarkdown body={'**Bold** and *italic* with `inline`\n\n- one\n- two\n\n1. first\n2. second\n\n[Example](https://example.com)\n\n```js\nconst n = 1;\n```'}/>);
 for(const text of ['<strong>Bold</strong>','<em>italic</em>','<code>inline</code>','<ul>','<ol>','<li>','<pre>','target="_blank"','rel="noopener noreferrer"'])expect(html).toContain(text);
});
it('never executes HTML or permits script URLs, embeds, or remote images',()=>{
 const html=renderToStaticMarkup(<MessageMarkdown body={'<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://evil.test"></iframe>\n\n[bad](javascript:alert%281%29)\n\n![tracking](https://evil.test/pixel)\n\n`<b>literal code</b>`'}/>);
 for(const text of ['<script','<img','<iframe','onerror','href="javascript:','src="https://evil'])expect(html).not.toContain(text);
 expect(html).toContain('&lt;b&gt;literal code&lt;/b&gt;');
});
