import * as React from 'react';

/** ⓘ whose text shows on hover/focus (the existing .nf2-tip tooltip). Supplementary text lives here so the form shows only what changes behavior. */
export function Tip({ text }: { text: string }) {
  return <span className="nf2-tip nf2-tip-i" tabIndex={0} role="note" aria-label={text} data-tip={text}>ⓘ</span>;
}
