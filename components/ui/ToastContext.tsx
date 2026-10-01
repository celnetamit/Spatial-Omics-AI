import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Toast, type ToastMessage, type ToastTone } from './Toast';

interface ToastApi {
  push: (tone: ToastTone, title: string, detail?: string, duration?: number) => void;
}

const Context = createContext<ToastApi>({ push: () => {} });

export function useToast(): ToastApi {
  return useContext(Context);
}

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  const dismiss = useCallback((id: string) => {
    setMessages((current) => current.filter((message) => message.id !== id));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      push: (tone, title, detail, duration) => {
        const message: ToastMessage = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          tone,
          title,
          ...(detail !== undefined ? { detail } : {}),
          // An error stays until it is dismissed. A message that removes itself
          // before it has been read is the same as not having shown it.
          duration: duration ?? (tone === 'error' ? 0 : 6000),
        };
        setMessages((current) => [...current.slice(-3), message]);
      },
    }),
    [],
  );

  return (
    <Context.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {messages.map((message) => (
          <div key={message.id} className="pointer-events-auto">
            <Toast message={message} onDismiss={dismiss} />
          </div>
        ))}
      </div>
    </Context.Provider>
  );
}
