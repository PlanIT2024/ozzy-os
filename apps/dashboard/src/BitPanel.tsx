import { useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

type Props = {
 anchor: RefObject<HTMLButtonElement | null>;
 avatar: ReactNode;
 title: string;
 children: ReactNode;
 onClose: () => void;
 chat?: boolean;
};

/** Shared, scrollable shell for presence and future dashboard conversations. */
export function BitPanel({ anchor, avatar, title, children, onClose, chat = false }: Props) {
 const panel = useRef<HTMLDialogElement>(null);
 const closeButton = useRef<HTMLButtonElement>(null);
 const titleId = useId();
 useLayoutEffect(() => {
  const dialog = panel.current!;
  const mobile = window.matchMedia('(max-width: 639px)');
  let unlock: (() => void) | undefined;
  function update() {
   if (mobile.matches) {
    if (!unlock) {
     const body = document.body;
     const keys = ['position', 'top', 'left', 'right', 'width', 'overflow'] as const;
     const saved = Object.fromEntries(keys.map(key => [key, body.style[key]]));
     const x = window.scrollX, y = window.scrollY;
     Object.assign(body.style, { position: 'fixed', top: `-${y}px`, left: '0', right: '0', width: '100%', overflow: 'hidden' });
     unlock = () => { for (const key of keys) body.style[key] = saved[key]; window.scrollTo(x, y); };
    }
    dialog.style.left = '0px';
    dialog.style.top = `${window.visualViewport?.offsetTop || 0}px`;
    dialog.style.height = `${window.visualViewport?.height || window.innerHeight}px`;
    dialog.style.maxHeight = '';
    dialog.style.maxWidth = '';
    return;
   }
   unlock?.(); unlock = undefined;
   dialog.style.height = '';
   const viewport = window.visualViewport;
   const x = viewport?.offsetLeft || 0, y = viewport?.offsetTop || 0;
   const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
   const margin = 12, gap = 10;
   dialog.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
   dialog.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
   const trigger = anchor.current!.getBoundingClientRect();
   const box = dialog.getBoundingClientRect();
   const below = trigger.bottom + gap;
   const preferredTop = below + box.height <= y + height - margin ? below : trigger.top - gap - box.height;
   dialog.style.left = `${Math.max(x + margin, Math.min(trigger.right - box.width, x + width - box.width - margin))}px`;
   dialog.style.top = `${Math.max(y + margin, Math.min(preferredTop, y + height - box.height - margin))}px`;
  }
  dialog.showModal();
  update();
  closeButton.current!.focus({ preventScroll: true });
  const observer = new ResizeObserver(update);
  observer.observe(dialog);
  window.addEventListener('resize', update);
  window.addEventListener('scroll', update, true);
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
  mobile.addEventListener('change', update);
  return () => {
   observer.disconnect();
   window.removeEventListener('resize', update);
   window.removeEventListener('scroll', update, true);
   window.visualViewport?.removeEventListener('resize', update);
   window.visualViewport?.removeEventListener('scroll', update);
   mobile.removeEventListener('change', update);
   dialog.close();
   unlock?.();
   anchor.current?.focus({ preventScroll: true });
  };
 }, [anchor, onClose]);
 return <dialog ref={panel} className={`bit-panel${chat ? ' bit-panel-chat' : ''}`} aria-labelledby={titleId}
  onKeyDown={event => {
   if (event.key !== 'Tab') return;
   const dialog = event.currentTarget;
   const controls = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(el => el.getClientRects().length && !el.closest('[inert]'));
   const first = controls[0], last = controls.at(-1);
   if (!first) { event.preventDefault(); dialog.focus(); }
   else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last!.focus(); }
   else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }}
  onCancel={event => { event.preventDefault(); onClose(); }}
  onClick={event => {
   if (event.target !== event.currentTarget || window.matchMedia('(max-width: 639px)').matches) return;
   const box = event.currentTarget.getBoundingClientRect();
   if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
  }}>
  <div className="bit-panel-header">
   <div aria-hidden="true">{avatar}</div>
   <h2 id={titleId}>{title}</h2>
   <button ref={closeButton} type="button" className="bit-panel-close" aria-label="Close bIT panel" onClick={onClose}>×</button>
  </div>
  <div className="bit-panel-body">{children}</div>
 </dialog>;
}
