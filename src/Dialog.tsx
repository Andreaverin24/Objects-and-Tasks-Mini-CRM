import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export function Dialog({ titleId, busy, onCancel, children }: {
  titleId: string;
  busy: boolean;
  onCancel: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return (
    <dialog ref={dialogRef} className="panel dialog" aria-labelledby={titleId}
      aria-busy={busy} onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}>
      {children}
    </dialog>
  );
}
