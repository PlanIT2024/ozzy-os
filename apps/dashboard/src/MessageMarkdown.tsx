import Markdown from 'react-markdown';

/** CommonMark text only: no HTML parser, embeds, images, or model-supplied props. */
export function MessageMarkdown({ body }: { body: string }) {
 return <div className="message-markdown"><Markdown skipHtml
  allowedElements={['p','strong','em','ul','ol','li','a','code','pre','blockquote','br','hr','h1','h2','h3','h4','h5','h6']}
  components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}
 >{body}</Markdown></div>;
}
