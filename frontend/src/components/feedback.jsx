import React, {createContext, useCallback, useContext, useRef, useState} from 'react';
import {CircleAlert, CircleCheck} from 'lucide-react';
import {Button, Dialog} from './ui.jsx';

const FeedbackContext = createContext(null);

export function FeedbackProvider({children}) {
  const [toasts, setToasts] = useState([]);
  const [pending, setPending] = useState(null);
  const seq = useRef(0);

  const toast = useCallback((text, tone = 'ok') => {
    const id = ++seq.current;
    setToasts(list => [...list.slice(-3), {id, text, tone}]);
    setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), tone === 'error' ? 8000 : 4200);
  }, []);

  // confirm() mengembalikan Promise<boolean>, pengganti window.confirm yang bisa diberi konteks.
  const confirm = useCallback(options => new Promise(resolve => setPending({...options, resolve})), []);
  const settle = value => { pending.resolve(value); setPending(null); };

  return (
    <FeedbackContext.Provider value={{toast, confirm}}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={'toast ' + t.tone}>
            {t.tone === 'error' ? <CircleAlert size={16}/> : <CircleCheck size={16}/>}<span>{t.text}</span>
          </div>
        ))}
      </div>
      {pending && (
        <Dialog title={pending.title} onClose={() => settle(false)} size="sm">
          <div className="dialog-body"><p className="confirm-text">{pending.body}</p></div>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => settle(false)}>Batal</Button>
            <Button variant={pending.danger ? 'danger' : 'primary'} onClick={() => settle(true)} autoFocus>{pending.confirmLabel || 'Lanjutkan'}</Button>
          </div>
        </Dialog>
      )}
    </FeedbackContext.Provider>
  );
}

export const useToast = () => useContext(FeedbackContext).toast;
export const useConfirm = () => useContext(FeedbackContext).confirm;
