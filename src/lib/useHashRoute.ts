import { useCallback, useEffect, useState } from 'react';

export interface Route {
  path: string;
  parts: string[];
}

function read(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const path = raw.split('?')[0];
  return { path, parts: path.split('/').filter(Boolean) };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string, replace = false) {
  const hash = `#/${path.replace(/^\//, '')}`;
  if (replace) window.location.replace(hash);
  else window.location.hash = hash;
}

export function useNavigate() {
  return useCallback((path: string, replace = false) => navigate(path, replace), []);
}
