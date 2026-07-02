
//Helper code to mock local data
const USE_MOCK = window.APP_CONFIG?.USE_MOCK;

function handleAuthError(res) {
    if (res.status === 401 || res.status === 403) {
        // Only clear this environment's keys — localStorage.clear() would also
        // wipe the other environment's session if both are open in tabs.
        localStorage.removeItem(window.authStorageKey("authToken"));
        localStorage.removeItem(window.authStorageKey("token"));
        localStorage.removeItem(window.authStorageKey("userRole"));
        localStorage.removeItem(window.authStorageKey("userLoginID"));
        window.location.href = "login.html";
        return true;
    }
    return false;
}

async function apiGet(endpoint, mockFile) {
    if (USE_MOCK) {
        const res = await fetch(`./mockdata/${mockFile}`);
        return await res.json();
    }

    const token = localStorage.getItem(window.authStorageKey("authToken"));

    const res = await fetch(`${window.APP_CONFIG.API_BASE_URL}${endpoint}`, {
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        }
    });

    if (handleAuthError(res)) return null;
    return await res.json();
}

async function apiPost(endpoint, body) {
    if (USE_MOCK) {
        return { success: true };
    }

    const token = localStorage.getItem(window.authStorageKey("authToken"));

    const res = await fetch(`${window.APP_CONFIG.API_BASE_URL}${endpoint}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify(body)
    });

    if (handleAuthError(res)) return null;
    return await res.json();
}
