const AUTH_TOKEN_KEY = 'pertisk_auth_token';
const AUTH_USER_KEY = 'pertisk_auth_user';
const AUTH_EXPIRY_KEY = 'pertisk_auth_expiry';

export const setAuth = (token: string, username: string, expiresIn: number = 3600) => {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_USER_KEY, username);
  // Store expiry time (current time + expiresIn seconds)
  const expiryTime = Date.now() + (expiresIn * 1000);
  localStorage.setItem(AUTH_EXPIRY_KEY, expiryTime.toString());
};

export const clearAuth = () => {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
  localStorage.removeItem(AUTH_EXPIRY_KEY);
};

export const getAuthToken = () => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  
  // Check if token is expired
  if (token && isTokenExpired()) {
    clearAuth();
    return null;
  }
  
  return token ? `Bearer ${token}` : null;
};

export const getRawAuthToken = () => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);

  if (token && isTokenExpired()) {
    clearAuth();
    return null;
  }

  return token;
};

export const getAuthUser = () => {
  return localStorage.getItem(AUTH_USER_KEY);
};

export const isTokenExpired = (): boolean => {
  const expiryTime = localStorage.getItem(AUTH_EXPIRY_KEY);
  if (!expiryTime) return true;
  
  return Date.now() > parseInt(expiryTime);
};

export const isAuthenticated = () => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  return Boolean(token) && !isTokenExpired();
};

export const getTokenExpiry = (): number | null => {
  const expiry = localStorage.getItem(AUTH_EXPIRY_KEY);
  return expiry ? parseInt(expiry, 10) : null;
};

// Returns the new expiry timestamp on success, null on failure
export const refreshToken = async (): Promise<number | null> => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) return null;
  try {
    const res = await fetch('/api/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as { success: boolean; token?: string };
    if (data.success && data.token) {
      const user = localStorage.getItem(AUTH_USER_KEY) ?? '';
      setAuth(data.token, user);
      return getTokenExpiry();
    }
  } catch {
    // network error
  }
  return null;
};
