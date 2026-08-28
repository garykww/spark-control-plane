import { useEffect, useRef, useState } from 'react';

/*
 * Charts are drawn in real pixels rather than a scaled viewBox, so that a 2px
 * stroke stays 2px instead of being stretched into an ellipse by a non-uniform
 * preserveAspectRatio. That means every chart needs its measured size.
 */
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((current) =>
        Math.abs(current.width - width) < 1 && Math.abs(current.height - height) < 1
          ? current
          : { width, height },
      );
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}
