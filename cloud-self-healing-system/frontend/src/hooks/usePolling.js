import { useEffect, useRef } from 'react';

export function usePolling(callback, intervalMs = 5000, dependencies = []) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    callbackRef.current();
    const interval = setInterval(() => callbackRef.current(), intervalMs);
    return () => clearInterval(interval);
  }, [intervalMs, ...dependencies]);
}
