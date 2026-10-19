import type { DetailedHTMLProps, HTMLAttributes } from 'react';
declare module 'react' {
 namespace JSX {
  interface IntrinsicElements {
   'bit-orb': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
  }
 }
}
declare module '*bit-orb.js';
