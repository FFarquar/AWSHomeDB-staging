
    function formatDate(dateStr) {
        if (!dateStr) return "";
        const parts = dateStr.split("-");
        if (parts.length !== 3) return dateStr;
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }

    const API = window.APP_CONFIG.API_BASE_URL;
    let token = localStorage.getItem("authToken");

    if (!window.APP_CONFIG?.USE_MOCK) {
        if (!token) window.location.href = "login.html";
    } else {
        token = "local-mock-token-xyz";
    }

    // --- GLOBAL RUNTIME VARIABLES STATE CACHES ---

    let containers = [];
    let childItems = [];
    let currentItemAttachments = [];
    let items = []; // Holds items in local mock mode

    let currentItemNotes = [];     // Notes collection for the currently open item
    let editingNoteId = null;      // noteId of the note being edited (null = adding new)
    let currentNoteAttachments = []; // Attachments staged for the note form

    let currentItemParts = [];       // Parts collection for the currently open item
    let editingPartId = null;        // partId of the part being edited (null = adding new)
    let currentPartAttachments = []; // Attachments staged for the part form

    let uploadSettings = { pdfSizeLimitMB: 5, imageCompressionEnabled: true, showContainerButtons: true };

    let editingAttachmentIdx = null; // Index in currentItemAttachments being viewed/deleted

    let editingId = null;       // Tracks primary container PK edits
    let editingItemId = null;   // Tracks child item ID edits
    let activeShortContainerId = null; // Tracks active parent container (short form ID)
    let activeContainerPK = null;      // Tracks active parent container full PK for edit/delete

    const userRole = localStorage.getItem("userRole") || "USER";
    
    // 🔐 NEW PERMISSION STRUCTURE
    const isAdmin = userRole === "ADMIN";                                 // Container access
    const canManageItems = userRole === "ADMIN" || userRole === "USER";   // Item access (Full USER + ADMIN)

    document.addEventListener("DOMContentLoaded", () => {
        // 1. Lock down Container actions if not an Admin
        if (!isAdmin) {
            const btnNew = document.getElementById("btnNewContainer");
            if (btnNew) btnNew.style.display = "none";
        }

        // 2. Lock down Item actions ONLY if they lack item permissions (e.g. GUEST)
        if (!canManageItems) {
            const btnNewI = document.getElementById("btnNewItem");
            if (btnNewI) btnNewI.style.display = "none";
        }

        // 3. Show admin panel button only for admins
        if (isAdmin) {
            const btnAdmin = document.getElementById("btnAdminPanel");
            if (btnAdmin) btnAdmin.style.display = "";
        }

        // 4. Display build version in header
        fetch("version.json")
            .then(r => r.json())
            .then(v => {
                const badge = document.getElementById("versionBadge");
                if (badge && v.build) badge.textContent = `build #${v.build}`;
            })
            .catch(() => {});

        // 5. Display environment badge in header
        const env = window.APP_CONFIG?.ENVIRONMENT;

        loadContainers();
        loadCategories();
        fetchUploadSettings();

        history.replaceState({ view: 'app' }, '');
        history.pushState({ view: 'app' }, '');
        window.addEventListener('popstate', handlePopState);
    });

    function handlePopState() {
        const isOpen = id => {
            const el = document.getElementById(id);
            return el && el.style.display && el.style.display !== 'none';
        };

        if (isOpen('noteModal'))          { closeNoteForm();             history.pushState({ view: 'app' }, ''); return; }
        if (isOpen('partModal'))          { closePartForm();             history.pushState({ view: 'app' }, ''); return; }
        if (isOpen('attachmentModal'))    { if (window._uploadInProgress) { history.pushState({ view: 'app' }, ''); return; } closeAttachmentForm(); history.pushState({ view: 'app' }, ''); return; }
        if (isOpen('deleteConfirmModal')) { closeDeleteModal();          history.pushState({ view: 'app' }, ''); return; }
        if (isOpen('itemModal'))          { closeItemModal();            history.pushState({ view: 'app' }, ''); return; }
        if (isOpen('modal'))              { closeModal();                history.pushState({ view: 'app' }, ''); return; }
        if (isOpen('adminPasswordModal')) { closeAdminPasswordModal();   history.pushState({ view: 'app' }, ''); return; }
        if (isOpen('adminUserFormModal')) { closeAdminUserForm();        history.pushState({ view: 'app' }, ''); return; }
        if (isOpen('adminModal'))         { closeAdminPanel();           history.pushState({ view: 'app' }, ''); return; }

        const itemsPanel = document.getElementById('itemsPanelView');
        if (itemsPanel && itemsPanel.style.display !== 'none') {
            activeShortContainerId = null;
            activeContainerPK = null;
            const btnEdit = document.getElementById("btnEditContainer");
            const btnDelete = document.getElementById("btnDeleteContainer");
            if (btnEdit) btnEdit.style.display = "none";
            if (btnDelete) btnDelete.style.display = "none";
            itemsPanel.style.display = 'none';
            document.getElementById('containersPanelView').style.display = 'block';
            history.pushState({ view: 'app' }, '');
            return;
        }

        history.pushState({ view: 'app' }, '');
    }

    function authHeaders() {
        return {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${localStorage.getItem("authToken")}`
        };
    }

    function checkAuthResponse(res) {
        if (res.status === 401 || res.status === 403) {
            localStorage.clear();
            window.location.href = "login.html";
            return false;
        }
        return true;
    }
 // ==========================================
    // CATEGORIES
    // ==========================================
    async function loadCategories() {
        if (window.APP_CONFIG?.USE_MOCK) return; // mock mode: populated via syncCategoryDatalist() after loadItems
        try {
            const categories = await apiGet("/categories");
            if (!Array.isArray(categories)) return;
            populateCategoryDatalist(categories);
        } catch (err) {
            console.warn("Could not load categories:", err.message);
        }
    }

    function syncCategoryDatalist() {
        const cats = [...new Set(
            (childItems || []).map(i => i.category).filter(c => c && c.trim())
        )].sort();
        populateCategoryDatalist(cats);
    }

    function populateCategoryDatalist(categories) {
        const datalist = document.getElementById("categoryOptions");
        if (!datalist) return;
        const existing = new Set([...datalist.options].map(o => o.value));
        categories.forEach(c => {
            if (!existing.has(c)) {
                const opt = document.createElement("option");
                opt.value = c;
                datalist.appendChild(opt);
            }
        });
    }

    function addCategoryToDatalist(category) {
        if (category && category.trim()) populateCategoryDatalist([category.trim()]);
    }

 // ==========================================
    // SECTION 1: CONTAINERS LOGIC METHODS
    // ==========================================
    async function loadContainers() {
        try {
            // ✨ FIXED: Pulls straight from your apiClient file wrapper with zero hardcoded references
            containers = await apiGet("/containers", "mock-containers.json");
            
            if (!Array.isArray(containers)) {
                console.warn("⚠️ Warning: mock-containers.json data format is missing or invalid.");
                containers = [];
            }
            
            renderTable();
            loadItemCountsAsync();
        } catch (err) {
            console.error("💥 Failed to read local container mock files:", err);
            containers = [];
            renderTable();
        }
    }

    function renderTable() {
        const body = document.getElementById("tableBody");
        if (!body) return;
        body.innerHTML = "";

        containers.forEach(c => {
            const pk = c.PK;
            const shortId = (c.containerId || pk.replace("CONTAINER#", "")).trim().toUpperCase();

            const row = document.createElement("tr");
            row.style.cursor = "pointer";

            row.innerHTML = `
                <td class="td-name"><strong>${c.name}</strong></td>
                <td data-label="Purchased">${formatDate(c.purchaseDate)}</td>
                <td data-label="Price">$${Number(c.purchasePrice || 0).toLocaleString()}</td>
                <td data-label="Warranty">${formatDate(c.extendedWarrantyFinishDate || c.warrantyFinishDate)}</td>
                <td data-item-count="${pk.replace('CONTAINER#', '').trim().toUpperCase()}" style="text-align:center; color:#888; font-style:italic;">...</td>
            `;

            row.addEventListener("click", () => openItems(pk, shortId));

            body.appendChild(row);
        });
    }

    async function loadItemCountsAsync() {
        let allMockItems = null;
        if (window.APP_CONFIG?.USE_MOCK) {
            try { allMockItems = await apiGet("/containers/mock/items", "mock-items.json"); } catch { allMockItems = []; }
        }

        await Promise.all(containers.map(async c => {
            const cleanId = c.PK.replace("CONTAINER#", "").trim().toUpperCase();
            const cell = document.querySelector(`td[data-item-count="${cleanId}"]`);
            if (!cell) return;
            try {
                let count = 0;
                if (window.APP_CONFIG?.USE_MOCK) {
                    const items = Array.isArray(allMockItems) ? allMockItems : [];
                    count = items.filter(i => (i.containerId || "").toUpperCase() === cleanId).length;
                } else {
                    const res = await fetch(`${API}/containers/${cleanId}/items`, { method: "GET", headers: authHeaders() });
                    if (res.ok) {
                        const items = await res.json();
                        count = Array.isArray(items) ? items.length : 0;
                    }
                }
                cell.textContent = count;
            } catch {
                cell.textContent = "-";
            }
            cell.style.color = "";
            cell.style.fontStyle = "";
        }));
    }

    function openCreate() {
        if (!isAdmin) return; 
        editingId = null;
        document.getElementById("modalTitle").innerText = "Create Container";
        clearForm();
        document.getElementById("modal").style.display = "flex";
    }

    function edit(pk) {
        if (!isAdmin) return;
        const item = containers.find(x => x.PK === pk);
        editingId = pk;

        document.getElementById("modalTitle").innerText = "Edit Container";
        document.getElementById("name").value = item.name || "";
        document.getElementById("purchaseDate").value = item.purchaseDate || "";
        document.getElementById("warrantyFinishDate").value = item.warrantyFinishDate || "";
        document.getElementById("extendedWarrantyFinishDate").value = item.extendedWarrantyFinishDate || "";
        document.getElementById("purchasePrice").value = item.purchasePrice || 0;

        document.getElementById("editHint").innerText = pk;
        document.getElementById("modal").style.display = "flex";
    }

    function editCurrentContainer() {
        if (!isAdmin || !activeContainerPK) return;
        edit(activeContainerPK);
    }

    function deleteCurrentContainer() {
        if (!isAdmin || !activeContainerPK) return;
        removeItem(activeContainerPK);
    }

     async function save() {
        if (!isAdmin) { showInfoPopup("Unauthorized action."); return; }

        const name = document.getElementById("name").value.trim();
        const purchaseDate = document.getElementById("purchaseDate").value;
        const warrantyFinishDate = document.getElementById("warrantyFinishDate").value;
        const extendedWarrantyFinishDate = document.getElementById("extendedWarrantyFinishDate").value;
        const purchasePrice = Number(document.getElementById("purchasePrice").value) || 0;

        if (!name) { showInfoPopup("Name required"); return; }

        const id = "CONTAINER" + Date.now();
        const pk = editingId || `CONTAINER#${id}`;
        const finalWarranty = extendedWarrantyFinishDate || warrantyFinishDate || "1970-01-01";

        const containerPayload = {
            PK: pk,
            SK: "METADATA",
            containerId: editingId ? editingId.replace("CONTAINER#", "") : id,
            name,
            purchaseDate,
            warrantyFinishDate,
            extendedWarrantyFinishDate: extendedWarrantyFinishDate || null,
            purchasePrice,
            entityType: "CONTAINER",
            itemName: name,
            warrantyExpiryDate: finalWarranty,
            category: "General",
            purchasedFrom: "Unknown"
        };

        if (window.APP_CONFIG?.USE_MOCK) {
            if (editingId) {
                // ✨ FIXED: Target "containers" instead of "localMockContainers"
                const index = containers.findIndex(c => c.PK === editingId);
                if (index !== -1) containers[index] = containerPayload;
            } else {
                // ✨ FIXED: Target "containers" instead of "localMockContainers"
                containers.push(containerPayload);
            }
            renderTable();
            closeModal();
            return; 
        }

        try {
            if (editingId) {
                const cleanId = editingId.replace("CONTAINER#", "");
                const update = {
                    name, itemName: name, purchaseDate,
                    warrantyFinishDate, extendedWarrantyFinishDate: extendedWarrantyFinishDate || null,
                    purchasePrice, warrantyExpiryDate: finalWarranty
                };
                await fetch(`${API}/containers/${cleanId}`, {
                    method: "PUT",
                    headers: authHeaders(),
                    body: JSON.stringify(update)
                });
            } else {
                await fetch(`${API}/containers`, {
                    method: "POST",
                    headers: authHeaders(),
                    body: JSON.stringify(containerPayload)
                });
            }
            closeModal();
            await loadContainers();
        } catch (err) {
            alert(`Failed network transaction: ${err.message}`);
        }
    }

    // ✨ PASTE DESTINATION LOCATION: Deletion intercepts and execution targets live here
    function removeItem(pk) {
        if (!isAdmin) return;
        const target = containers.find(c => c.PK === pk);
        const name = target ? target.name : "This Container";
        openDeleteModal("CONTAINER", pk, name);
    }

    function deleteChildItem(itemId) {
        if (!canManageItems) return;
        const target = childItems.find(i => i.itemId === itemId);
        const name = target ? target.itemName : "This Item";
        openDeleteModal("ITEM", itemId, name);
    }

    function deleteCurrentItem() {
        if (!editingItemId || !canManageItems) return;
        deleteChildItem(editingItemId);
    }

    async function finalizeContainerDelete(pk) {
        if (window.APP_CONFIG?.USE_MOCK) {
            // ✨ FIXED: Target "containers" array memory directly
            containers = containers.filter(c => c.PK !== pk);
            renderTable();
            showSuccessToast("Container deleted successfully.");
            return;
        }

        try {
            const cleanId = pk.replace("CONTAINER#", "");

            // Cascade: delete all child items (and their notes, parts, attachments) first
            try {
                const itemsRes = await fetch(`${API}/containers/${cleanId}/items`, {
                    method: "GET",
                    headers: authHeaders()
                });
                if (itemsRes.ok) {
                    const items = await itemsRes.json();
                    if (Array.isArray(items)) {
                        await Promise.all(items.map(async item => {
                            const itemId = item.itemId;

                            // Delete notes and their attachments
                            try {
                                const notesRes = await fetch(
                                    `${API}/containers/${cleanId}/items/${itemId}/notes`,
                                    { method: "GET", headers: authHeaders() }
                                );
                                if (notesRes.ok) {
                                    const notes = await notesRes.json();
                                    if (Array.isArray(notes)) {
                                        await Promise.all(notes.map(async note => {
                                            if (Array.isArray(note.attachments)) {
                                                await Promise.all(note.attachments.map(att =>
                                                    fetch(`${API}/attachments/delete`, {
                                                        method: "POST",
                                                        headers: authHeaders(),
                                                        body: JSON.stringify({
                                                            pk: `CONTAINER#${cleanId.toUpperCase()}`,
                                                            sk: `NOTE#${itemId}#${note.noteId}`,
                                                            attachmentId: att.attachmentId
                                                        })
                                                    }).catch(e => console.warn("Could not delete note attachment:", e))
                                                ));
                                            }
                                            return fetch(
                                                `${API}/containers/${cleanId}/items/${itemId}/notes/${note.noteId}`,
                                                { method: "DELETE", headers: authHeaders() }
                                            );
                                        }));
                                    }
                                }
                            } catch (noteErr) {
                                console.warn("Could not cascade delete notes for item:", itemId, noteErr);
                            }

                            // Delete parts and their attachments
                            try {
                                const partsRes = await fetch(
                                    `${API}/containers/${cleanId}/items/${itemId}/parts`,
                                    { method: "GET", headers: authHeaders() }
                                );
                                if (partsRes.ok) {
                                    const parts = await partsRes.json();
                                    if (Array.isArray(parts)) {
                                        await Promise.all(parts.map(async part => {
                                            if (Array.isArray(part.attachments)) {
                                                await Promise.all(part.attachments.map(att =>
                                                    fetch(`${API}/attachments/delete`, {
                                                        method: "POST",
                                                        headers: authHeaders(),
                                                        body: JSON.stringify({
                                                            pk: `CONTAINER#${cleanId.toUpperCase()}`,
                                                            sk: `PART#${itemId}#${part.partId}`,
                                                            attachmentId: att.attachmentId
                                                        })
                                                    }).catch(e => console.warn("Could not delete part attachment:", e))
                                                ));
                                            }
                                            return fetch(
                                                `${API}/containers/${cleanId}/items/${itemId}/parts/${part.partId}`,
                                                { method: "DELETE", headers: authHeaders() }
                                            );
                                        }));
                                    }
                                }
                            } catch (partErr) {
                                console.warn("Could not cascade delete parts for item:", itemId, partErr);
                            }

                            // Delete the item record
                            return fetch(
                                `${API}/containers/${cleanId}/items/${itemId}`,
                                { method: "DELETE", headers: authHeaders() }
                            ).catch(e => console.warn("Could not delete item:", itemId, e));
                        }));
                    }
                }
            } catch (itemErr) {
                console.warn("Could not cascade delete items:", itemErr);
            }

            const response = await fetch(`${API}/containers/${cleanId}`, {
                method: "DELETE",
                headers: authHeaders()
            });

            if (!response.ok) throw new Error(`Status: ${response.status}`);
            await loadContainers();
            showSuccessToast("Container deleted successfully.");
        } catch (error) {
            alert("Failed to delete the container from the cloud.");
        }
    }


     // ==========================================
    // SECTION 2: NESTED ITEMS LAYOUT METHODS
    // ==========================================
    async function openItems(pk, shortId) {
        // ✨ FIXED: Automatically strips the prefix to guarantee clean short string matches ("CONTAINER2")
        const cleanShortId = (shortId || pk || "").replace("CONTAINER#", "");

        activeShortContainerId = cleanShortId;
        activeContainerPK = pk;

        if (isAdmin && uploadSettings.showContainerButtons !== false) {
            const btnEdit = document.getElementById("btnEditContainer");
            const btnDelete = document.getElementById("btnDeleteContainer");
            if (btnEdit) btnEdit.style.display = "inline-block";
            if (btnDelete) btnDelete.style.display = "inline-block";
        }
        console.log(`📂 openItems triggered. Sanitized shortId to match items: [${cleanShortId}]`);

        // Safely check if the container list cache exists in active memory
        if (!Array.isArray(containers)) containers = [];
        
        const containerObj = containers.find(c => c.PK === pk || (c.containerId || "").replace("CONTAINER#", "") === cleanShortId);

        // Render dashboard header card labels with safe fallbacks
        document.getElementById("summaryContainerName").innerText = containerObj ? containerObj.name : cleanShortId;

        
        document.getElementById("summaryPurchaseDate").innerText = formatDate(containerObj?.purchaseDate) || "N/A";
        document.getElementById("summaryPurchasePrice").innerText = Number(containerObj?.purchasePrice || 0).toLocaleString();
        document.getElementById("summaryWarranty").innerText = formatDate(containerObj?.extendedWarrantyFinishDate || containerObj?.warrantyFinishDate) || "N/A";

        // View panel display visibility toggles
        document.getElementById("containersPanelView").style.display = "none";
        document.getElementById("itemsPanelView").style.display = "flex";
        history.pushState({ view: 'items' }, '');

        await loadItems();
    }

    function closeItemsPanel() {
        activeShortContainerId = null;
        activeContainerPK = null;
        const btnEdit = document.getElementById("btnEditContainer");
        const btnDelete = document.getElementById("btnDeleteContainer");
        if (btnEdit) btnEdit.style.display = "none";
        if (btnDelete) btnDelete.style.display = "none";
        document.getElementById("itemsPanelView").style.display = "none";
        document.getElementById("containersPanelView").style.display = "block";
    }

        async function loadItems() {
        const tbody = document.getElementById("itemsTableBody");
        if (!tbody) return;
        tbody.innerHTML = `<tr><td colspan="6">Searching for child records...</td></tr>`;

        if (window.APP_CONFIG?.USE_MOCK) {
            console.log("ℹ️ Fetching mock items collection utilizing apiClient wrapper channels...");
            try {
                const allMockItems = await apiGet(`/containers/${activeShortContainerId}/items`, "mock-items.json");
                const targetContainerId = (activeShortContainerId || "").toLowerCase();

                childItems = Array.isArray(allMockItems) 
                    ? allMockItems.filter(i => (i.containerId || "").toLowerCase() === targetContainerId) 
                    : [];
                    
                console.log(`📊 Filtered results for [${targetContainerId}]: Found ${childItems.length} items.`);
            } catch (err) {
                console.error("💥 Mock Item File Read Aborted:", err);
                tbody.innerHTML = `<tr><td colspan="8" style="color:red;">Mock Data Error: ${err.message}</td></tr>`;
                return;
            }
        } else {
            // Standard Live Cloud Production Network Pathway
            try {
                const res = await fetch(`${API}/containers/${activeShortContainerId}/items`, {
                    method: "GET",
                    headers: authHeaders()
                });
                if (!checkAuthResponse(res)) return;
                if (!res.ok) throw new Error(`Error Status: ${res.status}`);
                
                const rawItems = await res.json();
                
                // ✨ FIX: Map and normalise structural variations coming back from DynamoDB
                childItems = Array.isArray(rawItems) ? rawItems.map(item => {
                    // Check both legacy attachments column and your explicit itemAttachments schema property
                    let rawAtts = item.itemAttachments || item.attachments;
                    
                    if (typeof rawAtts === "string" && rawAtts.trim() !== "") {
                        try {
                            rawAtts = JSON.parse(rawAtts);
                        } catch (e) {
                            rawAtts = [];
                        }
                    }
                    
                    // Normalise every entry to have unified keys to satisfy your frontend HTML loops perfectly
                    item.attachments = Array.isArray(rawAtts) ? rawAtts.map(a => ({
                        ...a,
                        label: a.filename || a.label || "File Attachment",
                        s3Url: a.fileUrl || a.s3Url || ""
                    })) : [];
                    
                    return item;
                }) : [];

            } catch (err) {
                tbody.innerHTML = `<tr><td colspan="8" style="color:red;">Error fetching child collection: ${err.message}</td></tr>`;
                return;
            }
        }
        if (window.APP_CONFIG?.USE_MOCK) syncCategoryDatalist();
        renderItemsTable();
    }


    function renderItemsTable() {
        const tbody = document.getElementById("itemsTableBody");
        if (!tbody) return;
        tbody.innerHTML = "";

        if (childItems.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6">No items stored in this container segment room.</td></tr>`;
            return;
        }

        childItems.forEach(item => {
            const attCount = Array.isArray(item.attachments) ? item.attachments.length : 0;

            const row = document.createElement("tr");
            row.style.cursor = canManageItems ? "pointer" : "default";
            row.innerHTML = `
                <td class="td-name"><strong>${item.itemName || "Unnamed Asset"}</strong></td>
                <td data-label="Purchased">${formatDate(item.purchaseDate) || "N/A"}</td>
                <td data-label="Price">$${Number(item.purchasePrice || 0).toLocaleString()}</td>
                <td data-label="Warranty">${item.warrantyExpiryDate === "1970-01-01" ? "N/A" : (formatDate(item.warrantyExpiryDate) || "N/A")}</td>
                <td data-label="Notes" data-note-count="${item.itemId}">...</td>
                <td data-label="Parts" data-part-count="${item.itemId}">...</td>
                <td data-label="Attachments">${attCount}</td>
            `;

            if (canManageItems) {
                row.addEventListener("click", () => openItemEdit(item.itemId));
            }

            tbody.appendChild(row);
        });

        loadNoteCountsAsync();
        loadPartCountsAsync();
    }

    async function loadPartCountsAsync() {
        await Promise.all(childItems.map(async item => {
            const cell = document.querySelector(`td[data-part-count="${item.itemId}"]`);
            if (!cell) return;
            try {
                let count = 0;
                if (!window.APP_CONFIG?.USE_MOCK) {
                    const res = await fetch(
                        `${API}/containers/${activeShortContainerId}/items/${item.itemId}/parts`,
                        { method: "GET", headers: authHeaders() }
                    );
                    if (res.ok) {
                        const parts = await res.json();
                        count = Array.isArray(parts) ? parts.length : 0;
                    }
                }
                cell.textContent = count;
            } catch {
                cell.textContent = "-";
            }
        }));
    }

    async function loadNoteCountsAsync() {
        await Promise.all(childItems.map(async item => {
            const cell = document.querySelector(`td[data-note-count="${item.itemId}"]`);
            if (!cell) return;
            try {
                let count = 0;
                if (window.APP_CONFIG?.USE_MOCK) {
                    const allNotes = await apiGet(
                        `/containers/${activeShortContainerId}/items/${item.itemId}/notes`,
                        "mock-notes.json"
                    );
                    count = Array.isArray(allNotes)
                        ? allNotes.filter(n => n.containerId === activeShortContainerId && n.itemId === item.itemId).length
                        : 0;
                } else {
                    const res = await fetch(
                        `${API}/containers/${activeShortContainerId}/items/${item.itemId}/notes`,
                        { method: "GET", headers: authHeaders() }
                    );
                    if (res.ok) {
                        const notes = await res.json();
                        count = Array.isArray(notes) ? notes.length : 0;
                    }
                }
                cell.textContent = count;
            } catch {
                cell.textContent = "-";
            }
        }));
    }

     function openItemCreate() {
        if (!canManageItems) return;
        editingItemId = null;
        currentItemAttachments = [];
        document.getElementById("itemModalTitle").innerText = "Add New Item Asset";
        clearItemForm();
        const _t = new Date();
        document.getElementById("itemPurchaseDate").value = _t.getFullYear() + "-" + String(_t.getMonth() + 1).padStart(2, "0") + "-" + String(_t.getDate()).padStart(2, "0");
        renderModalAttachments();
        document.getElementById("notesSection").style.display = "none";
        document.getElementById("partsSection").style.display = "none";
        const btnDelete = document.getElementById("btnDeleteItem");
        if (btnDelete) btnDelete.style.display = "none";
        document.getElementById("itemModal").style.display = "flex";
    }

    async function openItemEdit(itemId) {
        if (!canManageItems) return;
        editingItemId = itemId;

        let target = childItems.find(i => i.itemId === itemId);

        if (!window.APP_CONFIG?.USE_MOCK) {
            try {
                const res = await fetch(`${API}/containers/${activeShortContainerId}/items/${itemId}`, {
                    method: "GET",
                    headers: authHeaders()
                });
                if (res.ok) {
                    const fresh = await res.json();
                    let rawAtts = fresh.itemAttachments || fresh.attachments;
                    if (typeof rawAtts === "string") {
                        try { rawAtts = JSON.parse(rawAtts); } catch (e) { rawAtts = []; }
                    }
                    fresh.attachments = Array.isArray(rawAtts) ? rawAtts.map(a => ({
                        ...a,
                        label: a.filename || a.label || "File Attachment",
                        s3Url: a.fileUrl || a.s3Url || ""
                    })) : [];
                    const idx = childItems.findIndex(i => i.itemId === itemId);
                    if (idx !== -1) childItems[idx] = { ...childItems[idx], ...fresh };
                    target = childItems[idx] ?? fresh;
                }
            } catch (err) {
                console.warn("Could not refresh item data from server:", err);
            }
        }

        document.getElementById("itemModalTitle").innerText = "Modify Item Properties";

        document.getElementById("itemName").value = target.itemName || "";
        document.getElementById("itemCategory").value = target.category || "";
        document.getElementById("itemPurchasedFrom").value = target.purchasedFrom || "";
        document.getElementById("itemPurchasePrice").value = target.purchasePrice || 0;
        document.getElementById("itemPurchaseDate").value = target.purchaseDate || "";
        document.getElementById("itemWarrantyExpiryDate").value = target.warrantyExpiryDate === "1970-01-01" ? "" : target.warrantyExpiryDate;
        document.getElementById("itemPhysicalLocation").value = target.physicalPaperStorageLocation || "";

        let rawAtts = target.attachments;
        if (typeof rawAtts === "string") {
            try { rawAtts = JSON.parse(rawAtts); } catch (e) { rawAtts = []; }
        }

        currentItemAttachments = Array.isArray(rawAtts) ? [...rawAtts] : [];

        renderAttachmentCards();

        // Show notes section and load existing notes for this item
        currentItemNotes = [];
        editingNoteId = null;
        currentNoteAttachments = [];
        document.getElementById("notesSection").style.display = "block";
        document.getElementById("noteModal").style.display = "none";

        // Show parts section and load existing parts for this item
        currentItemParts = [];
        editingPartId = null;
        currentPartAttachments = [];
        document.getElementById("partsSection").style.display = "block";
        document.getElementById("partModal").style.display = "none";

        const btnDelete = document.getElementById("btnDeleteItem");
        if (btnDelete) btnDelete.style.display = canManageItems ? "inline-block" : "none";
        loadNotes();
        loadParts();

        document.getElementById("attachmentCardsList").style.display = "none";
        document.getElementById("attachmentsToggle").textContent = "▼";
        document.getElementById("attachmentsAddBtn").style.display = "none";
        document.getElementById("notesList").style.display = "none";
        document.getElementById("notesToggle").textContent = "▼";
        document.getElementById("notesAddBtn").style.display = "none";
        document.getElementById("partsList").style.display = "none";
        document.getElementById("partsToggle").textContent = "▼";
        document.getElementById("partsAddBtn").style.display = "none";

        document.getElementById("itemModal").style.display = "flex";
    }

    function closeItemModal() {
        document.getElementById("itemModal").style.display = "none";
        editingItemId = null;
        currentItemNotes = [];
        editingNoteId = null;
        currentNoteAttachments = [];
        document.getElementById("noteModal").style.display = "none";
        currentItemParts = [];
        editingPartId = null;
        currentPartAttachments = [];
        document.getElementById("partModal").style.display = "none";
        editingAttachmentIdx = null;
        document.getElementById("attachmentModal").style.display = "none";
        clearItemForm();
    }

    function clearItemForm() {
        ["itemName", "itemCategory", "itemPurchasedFrom", "itemPurchasePrice", "itemPurchaseDate", "itemWarrantyExpiryDate", "itemPhysicalLocation"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = "";
        });

        currentItemAttachments = [];
        renderAttachmentCards();
    }

    function addAttachmentToState() {
        const lbl = document.getElementById("attLabel").value.trim();
        const url = document.getElementById("attUrl").value.trim();
        if (!lbl || !url) { showInfoPopup("Label and absolute path URL strings required."); return; }

        currentItemAttachments.push({
            attachmentId: "ATT#" + Date.now(),
            entityType: "ATTACHMENT",
            label: lbl,
            s3Url: url,
            fileType: url.endsWith(".pdf") ? "application/pdf" : "image/jpeg",
            uploadedDate: new Date().toISOString()
        });

        document.getElementById("attLabel").value = "";
        document.getElementById("attUrl").value = "";
        renderModalAttachments();
    }

// 🚀 ADD THIS NEW STATE CONTROLLER TO HANDLE DELETIONS MID-SESSION:
    async function removeAttachmentFromState(indexToDrop) {
        const att = currentItemAttachments[indexToDrop];
        const attName = att?.name || att?.label || att?.filename || "this attachment";

        if (!confirm(`Are you sure you want to delete "${attName}"? This cannot be undone.`)) return;

        if (editingItemId && att && att.attachmentId) {
            try {
                const cleanContainerId = String(activeShortContainerId).replace("CONTAINER#", "").trim();
                const cleanItemId = String(editingItemId).replace("ITEM#", "").trim();
                const res = await fetch(`${API}/attachments/delete`, {
                    method: "POST",
                    headers: authHeaders(),
                    body: JSON.stringify({
                        pk: `CONTAINER#${cleanContainerId.toUpperCase()}`,
                        sk: `ITEM#${cleanItemId.toUpperCase()}`,
                        attachmentId: att.attachmentId
                    })
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.message || `Status ${res.status}`);
                }
            } catch (error) {
                alert(`Failed to delete attachment: ${error.message}`);
                return;
            }
        }

        currentItemAttachments.splice(indexToDrop, 1);
        updateModalAttachmentListUI();
        renderAttachmentCards();
    }

    function updateModalAttachmentListUI() {
        const listElement = document.getElementById("modalAttachmentList");
        if (!listElement) return;

        // If there are no attachments uploaded yet, empty out the container block
        if (!currentItemAttachments || currentItemAttachments.length === 0) {
            listElement.innerHTML = `<li style="color:#888; font-style:italic; list-style:none; margin-left:-20px;">No files attached yet.</li>`;
            return;
        }

        // Loop through our attachments array list and generate interactive view rows
        listElement.innerHTML = currentItemAttachments.map((att, idx) => `
            <li style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px; background:#fff; padding:4px 8px; border-radius:4px; border:1px solid #eee;">
                <a href="${att.url}" target="_blank" style="color: #0073bb; text-decoration: none; font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%;">
                    📎 ${att.name || `File ${idx + 1}`}
                </a>
                <button type="button" onclick="removeAttachmentFromState(${idx})" style="background:#ff4d4d; color:white; border:none; border-radius:3px; padding:4px 10px; font-size:14px; cursor:pointer; font-weight:bold;">Remove</button>
            </li>
        `).join('');
    }


    function renderModalAttachments() {
        const list = document.getElementById("modalAttachmentList");
        if (!list) return;
        list.innerHTML = "";
        currentItemAttachments.forEach((a, i) => {
            const li = document.createElement("li");
            li.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;";
            li.innerHTML = `
                <a href="${a.s3Url}" target="_blank">${a.label}</a>
                <button type="button" onclick="removeAttachmentFromState(${i})" style="padding:4px 10px; background:red; color:white; font-size:14px; border:none; border-radius:3px; cursor:pointer;">X</button>
            `;
            list.appendChild(li);
        });
    }

    function renderAttachmentCards() {
        const list = document.getElementById("attachmentCardsList");
        if (!list) return;
        const countEl = document.getElementById("attachmentsCount");
        if (countEl) countEl.textContent = currentItemAttachments && currentItemAttachments.length > 0 ? `(${currentItemAttachments.length})` : "";
        if (!currentItemAttachments || currentItemAttachments.length === 0) {
            list.innerHTML = `<p style="color:#888; font-style:italic; font-size:13px; margin:0 0 6px 0;">No attachments yet.</p>`;
            return;
        }
        list.innerHTML = currentItemAttachments.map((att, idx) => {
            const name = att.filename || att.label || att.name || "Attachment";
            const url = att.fileUrl || att.s3Url || att.url || "";
            const safeName = name.replace(/'/g, "\\'");
            const safeUrl = url.replace(/'/g, "\\'");
            return `<div class="note-card" style="display:flex; justify-content:space-between; align-items:center;">
                <a href="#" class="note-att-link" onclick="confirmDownload(event, '${safeUrl}', '${safeName}'); return false;" style="color:#0073bb; text-decoration:none; font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:80%;">📎 ${name}</a>
                <button type="button" onclick="removeAttachmentFromState(${idx})" style="background:#ff4d4d; color:white; border:none; border-radius:50%; width:32px; height:32px; min-width:32px; min-height:32px; font-size:16px; line-height:32px; cursor:pointer; font-weight:bold; flex-shrink:0; align-self:center; text-align:center; padding:0; box-sizing:border-box;">×</button>
            </div>`;
        }).join("");
    }

    function openAddAttachment() {
        editingAttachmentIdx = null;
        document.getElementById("attachmentFormTitle").innerText = "Add Attachment";
        document.getElementById("itemFilePicker").value = "";
        document.getElementById("attachmentDisplayName").value = "";
        document.getElementById("uploadProgressBar").style.display = "none";
        document.getElementById("attachmentFilePickerRow").style.display = "block";
        document.getElementById("attachmentCurrentFile").style.display = "none";
        const btnDel = document.getElementById("btnDeleteAttachmentInForm");
        if (btnDel) btnDel.style.display = "none";
        document.getElementById("attachmentModal").style.display = "flex";
    }

    function openEditAttachment(idx) {
        const att = currentItemAttachments[idx];
        if (!att) return;
        editingAttachmentIdx = idx;
        document.getElementById("attachmentFormTitle").innerText = "Attachment";
        document.getElementById("attachmentFilePickerRow").style.display = "none";
        document.getElementById("uploadProgressBar").style.display = "none";
        const name = att.filename || att.label || att.name || "Attachment";
        const url = att.fileUrl || att.s3Url || att.url || "";
        const currentFileEl = document.getElementById("attachmentCurrentFile");
        currentFileEl.style.display = "block";
        currentFileEl.innerHTML = url
            ? `<a href="${url}" target="_blank" style="color:#0073bb; font-weight:bold;">📎 ${name}</a>`
            : `📎 ${name}`;
        const btnDel = document.getElementById("btnDeleteAttachmentInForm");
        if (btnDel) btnDel.style.display = "inline-block";
        document.getElementById("attachmentModal").style.display = "flex";
    }

    async function closeAttachmentForm() {
        const fileInput = document.getElementById("itemFilePicker");
        if (fileInput && fileInput.files.length > 0) {
            await handleAttachmentUpload();
            return;
        }
        document.getElementById("attachmentModal").style.display = "none";
        editingAttachmentIdx = null;
    }

    async function deleteAttachmentFromForm() {
        if (editingAttachmentIdx === null) return;
        await removeAttachmentFromState(editingAttachmentIdx);
        editingAttachmentIdx = null;
        closeAttachmentForm();
    }

        async function saveItem() {
        if (!canManageItems) { showInfoPopup("Action restricted."); return; }
        const nameVal = document.getElementById("itemName").value.trim();
        if (!nameVal) { showInfoPopup("Item Name is mandatory."); return; }

        // Clean file properties structure ensuring compatibility across both modal variations
        const cleanedAttachments = currentItemAttachments.map(att => ({
            attachmentId: att.attachmentId || `att-${Date.now()}`,
            filename: att.filename || att.label || "File Attachment",
            fileUrl: att.fileUrl || att.s3Url || "",
            label: att.filename || att.label || "File Attachment", 
            s3Url: att.fileUrl || att.s3Url || ""                  
        }));

        // ✨ The Fix: Payload variable strings mapped exactly to match items-create backend properties
        const payload = {
            itemName: nameVal,
            itemCategory: document.getElementById("itemCategory").value.trim() || "General",
            itempurchasedFrom: document.getElementById("itemPurchasedFrom").value.trim() || "Unknown",
            itempurchasePrice: Number(document.getElementById("itemPurchasePrice").value) || 0,
            itempurchaseDate: document.getElementById("itemPurchaseDate").value || null,
            itemwarrantyPeriod: document.getElementById("itemWarrantyExpiryDate").value || "1970-01-01",
            itemphysicalPaperStorageLocation: document.getElementById("itemPhysicalLocation").value.trim(),
            // 🌟 Crucial Alignment Fix: Matches body.itemAttachments exactly
            itemAttachments: cleanedAttachments 
        };

        if (window.APP_CONFIG?.USE_MOCK) {
            // Map prefixed payload keys to the flat names openItemEdit() reads (matching DynamoDB format)
            const flatPayload = {
                itemName: payload.itemName,
                category: payload.itemCategory,
                purchasedFrom: payload.itempurchasedFrom,
                purchasePrice: payload.itempurchasePrice,
                purchaseDate: payload.itempurchaseDate,
                warrantyExpiryDate: payload.itemwarrantyPeriod,
                physicalPaperStorageLocation: payload.itemphysicalPaperStorageLocation,
                attachments: payload.itemAttachments
            };
            if (editingItemId) {
                const idx = childItems.findIndex(i => i.itemId === editingItemId && i.containerId === activeShortContainerId);
                if (idx !== -1) Object.assign(childItems[idx], flatPayload);
            } else {
                const generatedId = "ITEM" + Date.now();
                childItems.push({
                    PK: `CONTAINER#${activeShortContainerId}`,
                    SK: `ITEM#${generatedId}`,
                    entityType: "ITEM",
                    containerId: activeShortContainerId,
                    itemId: generatedId,
                    createdDate: new Date().toISOString().split('T')[0],
                    ...flatPayload
                });
            }
            addCategoryToDatalist(payload.itemCategory);
            closeItemModal();
            showSuccessToast('Item saved successfully to the local mock!');
            renderItemsTable();
            return;
        }

        try {
            let path = `${API}/containers/${activeShortContainerId}/items`;
            let method = "POST";
            if (editingItemId) {
                path += `/${editingItemId}`;
                method = "PUT";
            }

            const response = await fetch(path, {
                method,
                headers: authHeaders(),
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error(`Rejection status: ${response.status}`);

            // Fetch the updated dataset completely from AWS
            await loadItems();

            addCategoryToDatalist(payload.itemCategory);

            // Close the form modal safely
            closeItemModal();

            // alert("Item saved successfully to the database!");
            showSuccessToast('Item saved successfully to the database!');

        } catch (error) {
            alert(`Save lifecycle failed: ${error.message}`);
        }
    }




    async function finalizeItemDelete(itemId) {
        if (window.APP_CONFIG?.USE_MOCK) {
            childItems = childItems.filter(i => i.itemId !== itemId);
            renderItemsTable();
            showSuccessToast("Item and related data deleted.");
            return;
        }

        try {
            // Cascade: delete all related notes first
            try {
                const notesRes = await fetch(
                    `${API}/containers/${activeShortContainerId}/items/${itemId}/notes`,
                    { method: "GET", headers: authHeaders() }
                );
                if (notesRes.ok) {
                    const notes = await notesRes.json();
                    if (Array.isArray(notes)) {
                        await Promise.all(notes.map(async note => {
                            if (Array.isArray(note.attachments)) {
                                await Promise.all(note.attachments.map(att =>
                                    fetch(`${API}/attachments/delete`, {
                                        method: "POST",
                                        headers: authHeaders(),
                                        body: JSON.stringify({
                                            pk: `CONTAINER#${activeShortContainerId.toUpperCase()}`,
                                            sk: `NOTE#${itemId}#${note.noteId}`,
                                            attachmentId: att.attachmentId
                                        })
                                    }).catch(e => console.warn("Could not delete note attachment:", e))
                                ));
                            }
                            return fetch(`${API}/containers/${activeShortContainerId}/items/${itemId}/notes/${note.noteId}`, {
                                method: "DELETE",
                                headers: authHeaders()
                            });
                        }));
                    }
                }
            } catch (noteErr) {
                console.warn("Could not cascade delete notes:", noteErr);
            }

            // Cascade: delete all related parts (and their S3 attachments) next
            try {
                const partsRes = await fetch(
                    `${API}/containers/${activeShortContainerId}/items/${itemId}/parts`,
                    { method: "GET", headers: authHeaders() }
                );
                if (partsRes.ok) {
                    const parts = await partsRes.json();
                    if (Array.isArray(parts)) {
                        await Promise.all(parts.map(async part => {
                            // Remove each part attachment from S3 before deleting the part record
                            if (Array.isArray(part.attachments)) {
                                await Promise.all(part.attachments.map(att =>
                                    fetch(`${API}/attachments/delete`, {
                                        method: "POST",
                                        headers: authHeaders(),
                                        body: JSON.stringify({
                                            pk: `CONTAINER#${activeShortContainerId.toUpperCase()}`,
                                            sk: `PART#${itemId}#${part.partId}`,
                                            attachmentId: att.attachmentId
                                        })
                                    }).catch(e => console.warn("Could not delete part attachment:", e))
                                ));
                            }
                            return fetch(`${API}/containers/${activeShortContainerId}/items/${itemId}/parts/${part.partId}`, {
                                method: "DELETE",
                                headers: authHeaders()
                            });
                        }));
                    }
                }
            } catch (partErr) {
                console.warn("Could not cascade delete parts:", partErr);
            }

            const res = await fetch(`${API}/containers/${activeShortContainerId}/items/${itemId}`, {
                method: "DELETE",
                headers: authHeaders()
            });
            if (!res.ok) throw new Error(`Server error: ${res.status}`);
            await loadItems();
            showSuccessToast("Item and related data deleted successfully.");
        } catch (err) {
            alert(`Delete transaction failure: ${err.message}`);
        }
    }

    // ==========================================
    // SECTION 3: SYSTEM UTILITIES METHODS
    // ==========================================

    async function confirmDownload(event, url, label) {
        event.preventDefault();
        if (!await showConfirmPopup(`Download "${label}"?`, "Download")) return;

        let downloadUrl = url;

        if (!window.APP_CONFIG?.USE_MOCK && url.includes('.amazonaws.com/')) {
            try {
                const s3Key = new URL(url).pathname.slice(1);
                const res = await fetch(`${API}/attachments/download?key=${encodeURIComponent(s3Key)}`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (!res.ok) throw new Error(`Presign failed: ${res.status}`);
                ({ downloadUrl } = await res.json());
            } catch (err) {
                alert(`Could not prepare download: ${err.message}`);
                return;
            }
        }

        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = label;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    // ✨ PASTE DESTINATION LOCATION: Global deletion state variables and helpers sit here
    let deleteTargetType = null; 
    let deleteTargetId = null;   

    function openDeleteModal(type, id, displayName) {
        deleteTargetType = type;
        deleteTargetId = id;

        const messageElement = document.getElementById("deleteModalMessage");
        const cascade = type === "ITEM"
            ? `<br><small style="color:#888;">All related notes, parts, and attachments will also be deleted.</small>`
            : "";
        messageElement.innerHTML = `Are you sure you want to permanently purge <br><strong>"${displayName}"</strong>?${cascade}`;

        document.getElementById("btnConfirmDelete").onclick = executeSystemDelete;
        document.getElementById("deleteConfirmModal").style.display = "flex";
    }

    function toggleCollectionSection(contentId, toggleId, addBtnId) {
        const content = document.getElementById(contentId);
        const toggle = document.getElementById(toggleId);
        const addBtn = addBtnId ? document.getElementById(addBtnId) : null;
        if (!content || !toggle) return;
        const isCollapsed = content.style.display === "none";
        content.style.display = isCollapsed ? "" : "none";
        if (addBtn) addBtn.style.display = isCollapsed ? "" : "none";
        toggle.textContent = isCollapsed ? "▲" : "▼";
    }

    function closeDeleteModal() {
        document.getElementById("deleteConfirmModal").style.display = "none";
        deleteTargetType = null;
        deleteTargetId = null;
    }

    async function executeSystemDelete() {
        const targetId = deleteTargetId;
        const targetType = deleteTargetType;

        closeDeleteModal();

        if (targetType === "CONTAINER") {
            await finalizeContainerDelete(targetId);
        } else if (targetType === "ITEM") {
            closeItemModal();
            await finalizeItemDelete(targetId);
        } else if (targetType === "NOTE") {
            await finalizeNoteDelete(targetId);
        } else if (targetType === "PART") {
            await finalizePartDelete(targetId);
        } else if (targetType === "USER") {
            await finalizeAdminUserDelete(targetId);
        }
    }

    // Existing utility functions remain below intact
    function clearForm() {
        ["name","purchaseDate","warrantyFinishDate","extendedWarrantyFinishDate","purchasePrice"]
        .forEach(id => document.getElementById(id).value = "");
        document.getElementById("editHint").innerText = "";
    }

    function closeModal() {
        document.getElementById("modal").style.display = "none";
        editingId = null;
        clearForm();
    }

    function logout() {
        localStorage.clear();
        window.location.href = "login.html";
    }

// Add this helper function somewhere in your script
function showSuccessToast(message) {
    // Create toast container
    const toast = document.createElement("div");
    
    // Style the toast (can also be done via CSS class)
    Object.assign(toast.style, {
        position: "fixed",
        bottom: "20px",
        right: "20px",
        backgroundColor: "#e6f4ea",
        color: "#137333",
        border: "1px solid #137333",
        padding: "12px 20px",
        borderRadius: "8px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        zIndex: "9999",
        display: "flex",
        alignItems: "center",
        gap: "8px",
        fontFamily: "sans-serif",
        transition: "opacity 0.5s ease, transform 0.5s ease",
        opacity: "0",
        transform: "translateY(20px)"
    });

    // Green tick + Text
    toast.innerHTML = `<span>✅</span> <span>${message}</span>`;
    document.body.appendChild(toast);

    // Trigger slide up and fade in
    setTimeout(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateY(0)";
    }, 10);

    // Fade out after 2 seconds, then remove from DOM
    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(20px)";
        setTimeout(() => toast.remove(), 500); // Wait for transition to finish
    }, 2000);
}

function showInfoPopup(message) {
    document.getElementById("infoPopupMessage").textContent = message;
    document.getElementById("infoPopupModal").style.display = "flex";
}

function closeInfoPopup() {
    document.getElementById("infoPopupModal").style.display = "none";
}

function showConfirmPopup(message, title) {
    return new Promise((resolve) => {
        document.getElementById("confirmPopupMessage").textContent = message;
        document.getElementById("confirmPopupTitle").textContent = title || "Confirm";
        const modal = document.getElementById("confirmPopupModal");
        modal.style.display = "flex";
        const btnYes = document.getElementById("btnConfirmPopupYes");
        const btnNo = document.getElementById("btnConfirmPopupNo");
        function cleanup() {
            modal.style.display = "none";
            btnYes.onclick = null;
            btnNo.onclick = null;
        }
        btnYes.onclick = () => { cleanup(); resolve(true); };
        btnNo.onclick = () => { cleanup(); resolve(false); };
    });
}

function setAttachmentUploadLock(locked) {
    const closeBtn = document.getElementById("attachmentCloseBtn");
    const uploadBtn = document.getElementById("attachmentUploadBtn");
    [closeBtn, uploadBtn].forEach(btn => {
        if (!btn) return;
        btn.disabled = locked;
        btn.style.opacity = locked ? "0.45" : "";
        btn.style.cursor = locked ? "not-allowed" : "";
    });
    window._uploadInProgress = locked;
    if (locked) {
        window._uploadBeforeUnload = e => { e.preventDefault(); e.returnValue = ""; };
        window.addEventListener("beforeunload", window._uploadBeforeUnload);
    } else {
        window.removeEventListener("beforeunload", window._uploadBeforeUnload);
        delete window._uploadBeforeUnload;
    }
}

async function handleAttachmentUpload() {
    const fileInput = document.getElementById("itemFilePicker");
    const progressStatus = document.getElementById("uploadProgressBar");

    if (!fileInput || !fileInput.files.length) {
        showInfoPopup("Please select a file first."); return;
    }

    const file = fileInput.files[0];
    const displayNameInput = document.getElementById("attachmentDisplayName");
    const displayName = displayNameInput?.value.trim() || file.name;
    fileInput.value = ""; // clear early so closeAttachmentForm won't re-trigger upload
    if (displayNameInput) displayNameInput.value = "";

    if (progressStatus) {
        progressStatus.style.display = "block";
        progressStatus.innerText = "⏳ Processing file upload...";
    }

    setAttachmentUploadLock(true);

    if (window.APP_CONFIG?.USE_MOCK) {
        const localMockUrl = URL.createObjectURL(file);
        currentItemAttachments.push({
            attachmentId: "ATT#" + Date.now(),
            label: displayName,
            s3Url: localMockUrl,
            name: displayName,
            url: localMockUrl
        });
        renderAttachmentCards();
        closeAttachmentForm();
        if (progressStatus) progressStatus.style.display = "none";
        fileInput.value = "";
        showSuccessToast(`Staged local mock for "${displayName}"`);
        return;
    }

    try {
        const fileToUpload = await checkAndPrepareFile(file, progressStatus);
        if (!fileToUpload) return;

        if (progressStatus) progressStatus.innerText = "⏳ Contacting AWS S3 Storage Gateway...";

        const _itemExt = fileToUpload.name.includes('.') ? '.' + fileToUpload.name.split('.').pop() : '';
        const s3Filename = (_itemExt && !displayName.toLowerCase().endsWith(_itemExt.toLowerCase())) ? displayName + _itemExt : displayName;
        const presignPath = `${API}/attachments/presign?filename=${encodeURIComponent(s3Filename)}&contentType=${encodeURIComponent(fileToUpload.type)}`;
        const res = await fetch(presignPath, { headers: authHeaders() });
        if (!res.ok) throw new Error("Failed getting secure token path.");

        const { uploadUrl, fileUrl } = await res.json();

        if (progressStatus) progressStatus.innerText = "⏳ Streaming file directly to S3...";

        const uploadRes = await fetch(uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": fileToUpload.type },
            body: fileToUpload
        });
        if (!uploadRes.ok) throw new Error("S3 gateway rejected target asset payload stream.");

        if (!editingItemId) {
            // 💡 PATHWAY A: BRAND NEW ITEM
            console.log("📝 Staging attachment locally until item creation is finalized.");

            const stagedAttachment = {
                attachmentId: `att-${Date.now()}`,
                filename: displayName,
                fileUrl: fileUrl,
                label: displayName,
                s3Url: fileUrl,
                name: displayName,
                url: fileUrl
            };

            currentItemAttachments.push(stagedAttachment);
            renderAttachmentCards();
            closeAttachmentForm();
            showSuccessToast(`Staged "${displayName}"! Will save with item.`);

        } else {
            // 💡 PATHWAY B: EXISTING ITEM
            if (progressStatus) progressStatus.innerText = "⏳ Logging file metadata to database...";

            const cleanContainerId = String(activeShortContainerId).replace("CONTAINER#", "").trim();
            const cleanItemId = String(editingItemId).replace("ITEM#", "").trim();

            const dbPayload = {
                pk: `CONTAINER#${cleanContainerId.toUpperCase()}`,
                sk: `ITEM#${cleanItemId}`,
                filename: displayName,
                fileUrl: fileUrl
            };

            const dbRes = await fetch(`${API}/attachments`, {
                method: "POST",
                headers: { ...authHeaders(), "Content-Type": "application/json" },
                body: JSON.stringify(dbPayload)
            });

            if (!dbRes.ok) throw new Error("Failed to link file to database row.");

            const dbResult = await dbRes.json();
            const rawAttachments = dbResult.attachments || [];

            currentItemAttachments = rawAttachments.map(att => ({
                ...att,
                label: att.filename || att.label,
                s3Url: att.fileUrl || att.s3Url
            }));

            renderAttachmentCards();
            closeAttachmentForm();
            showSuccessToast(`Uploaded "${displayName}" successfully!`);
        }

    } catch (err) {
        alert(`Attachment pipeline error: ${err.message}`); // Left intact to catch critical failures
    } finally {
        setAttachmentUploadLock(false);
        if (progressStatus) progressStatus.style.display = "none";
        fileInput.value = "";
    }
}

// ==========================================
// SECTION 4: NOTES LOGIC METHODS
// ==========================================

async function loadNotes() {
    if (!editingItemId || !activeShortContainerId) return;

    if (window.APP_CONFIG?.USE_MOCK) {
        try {
            const allNotes = await apiGet(
                `/containers/${activeShortContainerId}/items/${editingItemId}/notes`,
                "mock-notes.json"
            );
            currentItemNotes = Array.isArray(allNotes)
                ? allNotes.filter(n => n.containerId === activeShortContainerId && n.itemId === editingItemId)
                : [];
        } catch (err) {
            console.error("💥 Mock Notes Read Error:", err);
            currentItemNotes = [];
        }
    } else {
        try {
            const res = await fetch(`${API}/containers/${activeShortContainerId}/items/${editingItemId}/notes`, {
                method: "GET",
                headers: authHeaders()
            });
            if (!res.ok) throw new Error(`Status: ${res.status}`);
            const data = await res.json();
            currentItemNotes = Array.isArray(data) ? data.map(n => ({
                ...n,
                attachments: Array.isArray(n.attachments) ? n.attachments.map(a => ({
                    ...a,
                    label: a.filename || a.label || "File",
                    s3Url: a.fileUrl || a.s3Url || ""
                })) : []
            })) : [];
        } catch (err) {
            console.error("💥 Failed to load notes:", err);
            currentItemNotes = [];
        }
    }
    renderNotesSection();
}

function syncNoteCountCell() {
    const cell = document.querySelector(`td[data-note-count="${editingItemId}"]`);
    if (cell) cell.textContent = currentItemNotes.length;
}

function renderNotesSection() {
    const list = document.getElementById("notesList");
    if (!list) return;

    const countEl = document.getElementById("notesCount");
    if (countEl) countEl.textContent = currentItemNotes.length > 0 ? `(${currentItemNotes.length})` : "";

    if (currentItemNotes.length === 0) {
        list.innerHTML = `<p style="color:#888; font-style:italic; font-size:13px; margin:0 0 6px 0;">No notes recorded yet.</p>`;
        return;
    }

    list.innerHTML = currentItemNotes.map(note => {
        const attachLinks = note.attachments && note.attachments.length > 0
            ? note.attachments.map(a =>
                `<a href="#" class="note-att-link" onclick="confirmDownload(event, '${(a.s3Url || "").replace(/'/g, "\\'")}', '${(a.label || "attachment").replace(/'/g, "\\'")}'); return false;">📎 ${a.label}</a>`
              ).join("")
            : "";

        return `
            <div class="note-card" onclick="openEditNote('${note.noteId}')">
                <div class="note-date">${formatDate(note.date) || "No date"}</div>
                <div class="note-desc">${note.description || ""}</div>
                ${attachLinks ? `<div class="note-links">${attachLinks}</div>` : ""}
            </div>`;
    }).join("");
}

function openAddNote() {
    editingNoteId = null;
    currentNoteAttachments = [];
    document.getElementById("noteFormTitle").innerText = "Add Note";
    const _today = new Date();
    const _localDate = _today.getFullYear() + "-" + String(_today.getMonth() + 1).padStart(2, "0") + "-" + String(_today.getDate()).padStart(2, "0");
    document.getElementById("noteDate").value = _localDate;
    document.getElementById("noteDescription").value = "";
    renderNoteAttachmentList();
    const btnDel = document.getElementById("btnDeleteNoteInForm");
    if (btnDel) btnDel.style.display = "none";
    document.getElementById("noteModal").style.display = "flex";
}

function openEditNote(noteId) {
    const note = currentItemNotes.find(n => n.noteId === noteId);
    if (!note) return;

    editingNoteId = noteId;
    currentNoteAttachments = Array.isArray(note.attachments) ? [...note.attachments] : [];

    document.getElementById("noteFormTitle").innerText = "Edit Note";
    document.getElementById("noteDate").value = note.date || "";
    document.getElementById("noteDescription").value = note.description || "";
    renderNoteAttachmentList();
    const btnDel = document.getElementById("btnDeleteNoteInForm");
    if (btnDel) btnDel.style.display = "inline-block";
    document.getElementById("noteModal").style.display = "flex";
}

function closeNoteForm() {
    document.getElementById("noteModal").style.display = "none";
    editingNoteId = null;
    currentNoteAttachments = [];
}

function deleteNoteFromForm() {
    if (!editingNoteId) return;
    const noteIdToDelete = editingNoteId;
    closeNoteForm();
    confirmDeleteNote(noteIdToDelete);
}

function renderNoteAttachmentList() {
    const list = document.getElementById("noteAttachmentList");
    if (!list) return;

    if (!currentNoteAttachments || currentNoteAttachments.length === 0) {
        list.innerHTML = `<li style="color:#888; font-style:italic; list-style:none; margin-left:-20px; font-size:12px;">No files attached.</li>`;
        return;
    }

    list.innerHTML = currentNoteAttachments.map((att, idx) => `
        <li style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; background:#fff; padding:6px 8px; border-radius:3px; border:1px solid #eee;">
            <span style="font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:72%;">📎 ${att.filename || att.label || `File ${idx + 1}`}</span>
            <button type="button" onclick="removeNoteAttachmentFromState(${idx})" style="background:#ff4d4d; color:white; border:none; border-radius:3px; padding:4px 10px; font-size:14px; cursor:pointer; font-weight:bold;">X</button>
        </li>
    `).join("");
}

function removeNoteAttachmentFromState(idx) {
    currentNoteAttachments.splice(idx, 1);
    renderNoteAttachmentList();
}

async function handleNoteAttachmentUpload() {
    const fileInput = document.getElementById("noteFilePicker");
    const progressStatus = document.getElementById("noteUploadProgress");

    if (!fileInput || !fileInput.files.length) {
        showInfoPopup("Please select a file first.");
        return false;
    }

    const file = fileInput.files[0];
    const noteDisplayNameInput = document.getElementById("noteAttachmentDisplayName");
    const noteDisplayName = noteDisplayNameInput?.value.trim() || file.name;
    if (noteDisplayNameInput) noteDisplayNameInput.value = "";
    if (progressStatus) { progressStatus.style.display = "block"; progressStatus.innerText = "⏳ Processing..."; }

    if (window.APP_CONFIG?.USE_MOCK) {
        const localUrl = URL.createObjectURL(file);
        currentNoteAttachments.push({
            attachmentId: "ATT#" + Date.now(),
            filename: noteDisplayName,
            fileUrl: localUrl,
            label: noteDisplayName,
            s3Url: localUrl
        });
        renderNoteAttachmentList();
        if (progressStatus) progressStatus.style.display = "none";
        fileInput.value = "";
        showSuccessToast(`Staged "${noteDisplayName}" for note.`);
        return true;
    }

    try {
        const fileToUpload = await checkAndPrepareFile(file, progressStatus);
        if (!fileToUpload) return false;

        if (progressStatus) progressStatus.innerText = "⏳ Contacting AWS S3 Storage Gateway...";
        const _noteExt = fileToUpload.name.includes('.') ? '.' + fileToUpload.name.split('.').pop() : '';
        const noteS3Filename = (_noteExt && !noteDisplayName.toLowerCase().endsWith(_noteExt.toLowerCase())) ? noteDisplayName + _noteExt : noteDisplayName;
        const presignPath = `${API}/attachments/presign?filename=${encodeURIComponent(noteS3Filename)}&contentType=${encodeURIComponent(fileToUpload.type)}`;
        const res = await fetch(presignPath, { headers: authHeaders() });
        if (!res.ok) throw new Error("Failed to get presigned URL.");
        const { uploadUrl, fileUrl } = await res.json();

        if (progressStatus) progressStatus.innerText = "⏳ Uploading to S3...";
        const uploadRes = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": fileToUpload.type }, body: fileToUpload });
        if (!uploadRes.ok) throw new Error("S3 upload failed.");

        if (!editingNoteId) {
            // New note: stage locally until note is saved
            currentNoteAttachments.push({
                attachmentId: `att-${Date.now()}`,
                filename: noteDisplayName,
                fileUrl,
                label: noteDisplayName,
                s3Url: fileUrl
            });
            renderNoteAttachmentList();
            showSuccessToast(`Staged "${noteDisplayName}"! Will save with note.`);
        } else {
            // Existing note: persist attachment to DB immediately
            if (progressStatus) progressStatus.innerText = "⏳ Logging metadata to database...";
            const cleanContainerId = String(activeShortContainerId).replace("CONTAINER#", "").trim();
            const dbPayload = {
                pk: `CONTAINER#${cleanContainerId.toUpperCase()}`,
                sk: `NOTE#${editingItemId}#${editingNoteId}`,
                filename: noteDisplayName,
                fileUrl
            };
            const dbRes = await fetch(`${API}/attachments`, {
                method: "POST",
                headers: { ...authHeaders(), "Content-Type": "application/json" },
                body: JSON.stringify(dbPayload)
            });
            if (!dbRes.ok) throw new Error("Failed to link file to note record.");
            const dbResult = await dbRes.json();
            currentNoteAttachments = (dbResult.attachments || []).map(a => ({
                ...a,
                label: a.filename || a.label,
                s3Url: a.fileUrl || a.s3Url
            }));
            renderNoteAttachmentList();
            showSuccessToast(`Uploaded "${noteDisplayName}" to note!`);
        }
        return true;
    } catch (err) {
        alert(`Note attachment error: ${err.message}`);
        return false;
    } finally {
        if (progressStatus) progressStatus.style.display = "none";
        fileInput.value = "";
    }
}

async function saveNote() {
    const description = document.getElementById("noteDescription").value.trim();
    if (!description) { showInfoPopup("Description is required."); return; }

    const noteFilePicker = document.getElementById("noteFilePicker");
    if (noteFilePicker && noteFilePicker.files.length > 0) {
        const uploaded = await handleNoteAttachmentUpload();
        if (!uploaded) return;
    }

    const date = document.getElementById("noteDate").value || new Date().toISOString().split("T")[0];

    const cleanedAttachments = currentNoteAttachments.map(att => ({
        attachmentId: att.attachmentId || `att-${Date.now()}`,
        filename: att.filename || att.label || "File",
        label: att.filename || att.label || "File",
        fileUrl: att.fileUrl || att.s3Url || "",
        uploadedAt: att.uploadedAt || new Date().toISOString()
    }));

    const payload = { description, date, attachments: cleanedAttachments };

    if (window.APP_CONFIG?.USE_MOCK) {
        if (editingNoteId) {
            const idx = currentItemNotes.findIndex(n => n.noteId === editingNoteId);
            if (idx !== -1) Object.assign(currentItemNotes[idx], payload);
        } else {
            const generatedNoteId = "NOTE" + Date.now();
            currentItemNotes.push({
                PK: `CONTAINER#${activeShortContainerId}`,
                SK: `NOTE#${editingItemId}#${generatedNoteId}`,
                entityType: "NOTE",
                containerId: activeShortContainerId,
                itemId: editingItemId,
                noteId: generatedNoteId,
                createdDate: new Date().toISOString().split("T")[0],
                ...payload
            });
        }
        closeNoteForm();
        renderNotesSection();
        syncNoteCountCell();
        showSuccessToast("Note saved!");
        return;
    }

    try {
        let path = `${API}/containers/${activeShortContainerId}/items/${editingItemId}/notes`;
        let method = "POST";
        if (editingNoteId) {
            path += `/${editingNoteId}`;
            method = "PUT";
        }

        const res = await fetch(path, {
            method,
            headers: authHeaders(),
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(`Status: ${res.status}`);

        closeNoteForm();
        await loadNotes();
        syncNoteCountCell();
        showSuccessToast("Note saved successfully!");
    } catch (err) {
        alert(`Failed to save note: ${err.message}`);
    }
}

function confirmDeleteNote(noteId) {
    const note = currentItemNotes.find(n => n.noteId === noteId);
    const preview = note ? (note.description || "").substring(0, 50) : "This Note";
    openDeleteModal("NOTE", noteId, preview);
}

async function finalizeNoteDelete(noteId) {
    if (window.APP_CONFIG?.USE_MOCK) {
        currentItemNotes = currentItemNotes.filter(n => n.noteId !== noteId);
        renderNotesSection();
        syncNoteCountCell();
        showSuccessToast("Note deleted.");
        return;
    }

    try {
        // Remove note attachments from S3 before deleting the note record
        const note = currentItemNotes.find(n => n.noteId === noteId);
        if (note && Array.isArray(note.attachments) && note.attachments.length > 0) {
            await Promise.all(note.attachments.map(att =>
                fetch(`${API}/attachments/delete`, {
                    method: "POST",
                    headers: authHeaders(),
                    body: JSON.stringify({
                        pk: `CONTAINER#${activeShortContainerId.toUpperCase()}`,
                        sk: `NOTE#${editingItemId}#${noteId}`,
                        attachmentId: att.attachmentId
                    })
                }).catch(e => console.warn("Could not delete note attachment:", e))
            ));
        }

        const res = await fetch(
            `${API}/containers/${activeShortContainerId}/items/${editingItemId}/notes/${noteId}`,
            { method: "DELETE", headers: authHeaders() }
        );
        if (!res.ok) throw new Error(`Status: ${res.status}`);
        await loadNotes();
        syncNoteCountCell();
        showSuccessToast("Note deleted successfully.");
    } catch (err) {
        alert(`Failed to delete note: ${err.message}`);
    }
}

// ==========================================
// SECTION 5: PARTS LOGIC METHODS
// ==========================================

async function loadParts() {
    if (!editingItemId || !activeShortContainerId) return;

    if (window.APP_CONFIG?.USE_MOCK) {
        currentItemParts = [];
        renderPartsSection();
        return;
    }

    try {
        const res = await fetch(`${API}/containers/${activeShortContainerId}/items/${editingItemId}/parts`, {
            method: "GET",
            headers: authHeaders()
        });
        if (!res.ok) throw new Error(`Status: ${res.status}`);
        const data = await res.json();
        currentItemParts = Array.isArray(data) ? data.map(p => ({
            ...p,
            attachments: Array.isArray(p.attachments) ? p.attachments.map(a => ({
                ...a,
                label: a.filename || a.label || "File",
                s3Url: a.fileUrl || a.s3Url || ""
            })) : []
        })) : [];
    } catch (err) {
        console.error("💥 Failed to load parts:", err);
        currentItemParts = [];
    }
    renderPartsSection();
}

function syncPartCountCell() {
    const cell = document.querySelector(`td[data-part-count="${editingItemId}"]`);
    if (cell) cell.textContent = currentItemParts.length;
}

function renderPartsSection() {
    const list = document.getElementById("partsList");
    if (!list) return;

    const countEl = document.getElementById("partsCount");
    if (countEl) countEl.textContent = currentItemParts.length > 0 ? `(${currentItemParts.length})` : "";

    if (currentItemParts.length === 0) {
        list.innerHTML = `<p style="color:#888; font-style:italic; font-size:13px; margin:0 0 6px 0;">No parts recorded yet.</p>`;
        return;
    }

    list.innerHTML = currentItemParts.map(part => {
        const attachLinks = part.attachments && part.attachments.length > 0
            ? part.attachments.map(a =>
                `<a href="#" class="note-att-link" onclick="confirmDownload(event, '${(a.s3Url || "").replace(/'/g, "\\'")}', '${(a.label || "attachment").replace(/'/g, "\\'")}'); return false;">📎 ${a.label}</a>`
              ).join("")
            : "";

        const costDisplay = part.cost != null ? `$${Number(part.cost).toLocaleString()}` : "";
        const meta = [formatDate(part.purchaseDate), costDisplay, part.purchasedFrom, part.warrantyPeriod ? `Warranty: ${part.warrantyPeriod}` : ""]
            .filter(Boolean).join(" · ");

        return `
            <div class="note-card" onclick="openEditPart('${part.partId}')">
                <div class="note-date">${part.name || "Unnamed Part"}</div>
                ${meta ? `<div class="note-desc" style="font-size:14px; color:#555;">${meta}</div>` : ""}
                ${attachLinks ? `<div class="note-links">${attachLinks}</div>` : ""}
            </div>`;
    }).join("");
}

function openAddPart() {
    editingPartId = null;
    currentPartAttachments = [];
    document.getElementById("partFormTitle").innerText = "Add Part";
    document.getElementById("partName").value = "";
    const _t = new Date();
    document.getElementById("partPurchaseDate").value = _t.getFullYear() + "-" + String(_t.getMonth() + 1).padStart(2, "0") + "-" + String(_t.getDate()).padStart(2, "0");
    document.getElementById("partCost").value = "";
    document.getElementById("partPurchasedFrom").value = "";
    document.getElementById("partWarrantyPeriod").value = "";
    renderPartAttachmentList();
    const btnDel = document.getElementById("btnDeletePartInForm");
    if (btnDel) btnDel.style.display = "none";
    document.getElementById("partModal").style.display = "flex";
}

function openEditPart(partId) {
    const part = currentItemParts.find(p => p.partId === partId);
    if (!part) return;

    editingPartId = partId;
    currentPartAttachments = Array.isArray(part.attachments) ? [...part.attachments] : [];

    document.getElementById("partFormTitle").innerText = "Edit Part";
    document.getElementById("partName").value = part.name || "";
    document.getElementById("partPurchaseDate").value = part.purchaseDate || "";
    document.getElementById("partCost").value = part.cost != null ? part.cost : "";
    document.getElementById("partPurchasedFrom").value = part.purchasedFrom || "";
    document.getElementById("partWarrantyPeriod").value = part.warrantyPeriod || "";
    renderPartAttachmentList();
    const btnDel = document.getElementById("btnDeletePartInForm");
    if (btnDel) btnDel.style.display = "inline-block";
    document.getElementById("partModal").style.display = "flex";
}

function closePartForm() {
    document.getElementById("partModal").style.display = "none";
    editingPartId = null;
    currentPartAttachments = [];
}

function deletePartFromForm() {
    if (!editingPartId) return;
    const partIdToDelete = editingPartId;
    closePartForm();
    confirmDeletePart(partIdToDelete);
}

function renderPartAttachmentList() {
    const list = document.getElementById("partAttachmentList");
    if (!list) return;

    if (!currentPartAttachments || currentPartAttachments.length === 0) {
        list.innerHTML = `<li style="color:#888; font-style:italic; list-style:none; margin-left:-20px; font-size:12px;">No files attached.</li>`;
        return;
    }

    list.innerHTML = currentPartAttachments.map((att, idx) => `
        <li style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; background:#fff; padding:6px 8px; border-radius:3px; border:1px solid #eee;">
            <span style="font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:72%;">📎 ${att.filename || att.label || `File ${idx + 1}`}</span>
            <button type="button" onclick="removePartAttachmentFromState(${idx})" style="background:#ff4d4d; color:white; border:none; border-radius:3px; padding:4px 10px; font-size:14px; cursor:pointer; font-weight:bold;">X</button>
        </li>
    `).join("");
}

function removePartAttachmentFromState(idx) {
    currentPartAttachments.splice(idx, 1);
    renderPartAttachmentList();
}

async function handlePartAttachmentUpload() {
    const fileInput = document.getElementById("partFilePicker");
    const progressStatus = document.getElementById("partUploadProgress");

    if (!fileInput || !fileInput.files.length) {
        showInfoPopup("Please select a file first.");
        return false;
    }

    const file = fileInput.files[0];
    const partDisplayNameInput = document.getElementById("partAttachmentDisplayName");
    const partDisplayName = partDisplayNameInput?.value.trim() || file.name;
    if (partDisplayNameInput) partDisplayNameInput.value = "";
    if (progressStatus) { progressStatus.style.display = "block"; progressStatus.innerText = "⏳ Processing..."; }

    if (window.APP_CONFIG?.USE_MOCK) {
        const localUrl = URL.createObjectURL(file);
        currentPartAttachments.push({
            attachmentId: "ATT#" + Date.now(),
            filename: partDisplayName,
            fileUrl: localUrl,
            label: partDisplayName,
            s3Url: localUrl
        });
        renderPartAttachmentList();
        if (progressStatus) progressStatus.style.display = "none";
        fileInput.value = "";
        showSuccessToast(`Staged "${partDisplayName}" for part.`);
        return true;
    }

    try {
        const fileToUpload = await checkAndPrepareFile(file, progressStatus);
        if (!fileToUpload) return false;

        if (progressStatus) progressStatus.innerText = "⏳ Contacting AWS S3 Storage Gateway...";
        const _partExt = fileToUpload.name.includes('.') ? '.' + fileToUpload.name.split('.').pop() : '';
        const partS3Filename = (_partExt && !partDisplayName.toLowerCase().endsWith(_partExt.toLowerCase())) ? partDisplayName + _partExt : partDisplayName;
        const presignPath = `${API}/attachments/presign?filename=${encodeURIComponent(partS3Filename)}&contentType=${encodeURIComponent(fileToUpload.type)}`;
        const res = await fetch(presignPath, { headers: authHeaders() });
        if (!res.ok) throw new Error("Failed to get presigned URL.");
        const { uploadUrl, fileUrl } = await res.json();

        if (progressStatus) progressStatus.innerText = "⏳ Uploading to S3...";
        const uploadRes = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": fileToUpload.type }, body: fileToUpload });
        if (!uploadRes.ok) throw new Error("S3 upload failed.");

        if (!editingPartId) {
            // New part: stage locally until part is saved
            currentPartAttachments.push({
                attachmentId: `att-${Date.now()}`,
                filename: partDisplayName,
                fileUrl,
                label: partDisplayName,
                s3Url: fileUrl
            });
            renderPartAttachmentList();
            showSuccessToast(`Staged "${partDisplayName}"! Will save with part.`);
        } else {
            // Existing part: persist attachment to DB immediately
            if (progressStatus) progressStatus.innerText = "⏳ Logging metadata to database...";
            const cleanContainerId = String(activeShortContainerId).replace("CONTAINER#", "").trim();
            const dbPayload = {
                pk: `CONTAINER#${cleanContainerId.toUpperCase()}`,
                sk: `PART#${editingItemId}#${editingPartId}`,
                filename: partDisplayName,
                fileUrl
            };
            const dbRes = await fetch(`${API}/attachments`, {
                method: "POST",
                headers: { ...authHeaders(), "Content-Type": "application/json" },
                body: JSON.stringify(dbPayload)
            });
            if (!dbRes.ok) throw new Error("Failed to link file to part record.");
            const dbResult = await dbRes.json();
            currentPartAttachments = (dbResult.attachments || []).map(a => ({
                ...a,
                label: a.filename || a.label,
                s3Url: a.fileUrl || a.s3Url
            }));
            renderPartAttachmentList();
            showSuccessToast(`Uploaded "${partDisplayName}" to part!`);
        }
        return true;
    } catch (err) {
        alert(`Part attachment error: ${err.message}`);
        return false;
    } finally {
        if (progressStatus) progressStatus.style.display = "none";
        fileInput.value = "";
    }
}

async function savePart() {
    const name = document.getElementById("partName").value.trim();
    if (!name) { showInfoPopup("Name is required."); return; }

    const partFilePicker = document.getElementById("partFilePicker");
    if (partFilePicker && partFilePicker.files.length > 0) {
        const uploaded = await handlePartAttachmentUpload();
        if (!uploaded) return;
    }

    const cleanedAttachments = currentPartAttachments.map(att => ({
        attachmentId: att.attachmentId || `att-${Date.now()}`,
        filename: att.filename || att.label || "File",
        label: att.filename || att.label || "File",
        fileUrl: att.fileUrl || att.s3Url || "",
        uploadedAt: att.uploadedAt || new Date().toISOString()
    }));

    const payload = {
        name,
        purchaseDate: document.getElementById("partPurchaseDate").value || null,
        cost: document.getElementById("partCost").value !== "" ? Number(document.getElementById("partCost").value) : null,
        purchasedFrom: document.getElementById("partPurchasedFrom").value.trim() || null,
        warrantyPeriod: document.getElementById("partWarrantyPeriod").value.trim() || null,
        attachments: cleanedAttachments
    };

    if (window.APP_CONFIG?.USE_MOCK) {
        if (editingPartId) {
            const idx = currentItemParts.findIndex(p => p.partId === editingPartId);
            if (idx !== -1) Object.assign(currentItemParts[idx], payload);
        } else {
            const generatedPartId = "PART" + Date.now();
            currentItemParts.push({
                PK: `CONTAINER#${activeShortContainerId}`,
                SK: `PART#${editingItemId}#${generatedPartId}`,
                entityType: "PART",
                containerId: activeShortContainerId,
                itemId: editingItemId,
                partId: generatedPartId,
                createdDate: new Date().toISOString().split("T")[0],
                ...payload
            });
        }
        closePartForm();
        renderPartsSection();
        syncPartCountCell();
        showSuccessToast("Part saved!");
        return;
    }

    try {
        let path = `${API}/containers/${activeShortContainerId}/items/${editingItemId}/parts`;
        let method = "POST";
        if (editingPartId) {
            path += `/${editingPartId}`;
            method = "PUT";
        }

        const res = await fetch(path, {
            method,
            headers: authHeaders(),
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(`Status: ${res.status}`);

        closePartForm();
        await loadParts();
        syncPartCountCell();
        showSuccessToast("Part saved successfully!");
    } catch (err) {
        alert(`Failed to save part: ${err.message}`);
    }
}

function confirmDeletePart(partId) {
    const part = currentItemParts.find(p => p.partId === partId);
    const preview = part ? (part.name || "").substring(0, 50) : "This Part";
    openDeleteModal("PART", partId, preview);
}

async function finalizePartDelete(partId) {
    if (window.APP_CONFIG?.USE_MOCK) {
        currentItemParts = currentItemParts.filter(p => p.partId !== partId);
        renderPartsSection();
        syncPartCountCell();
        showSuccessToast("Part deleted.");
        return;
    }

    try {
        // Remove part attachments from S3 before deleting the part record
        const part = currentItemParts.find(p => p.partId === partId);
        if (part && Array.isArray(part.attachments) && part.attachments.length > 0) {
            await Promise.all(part.attachments.map(att =>
                fetch(`${API}/attachments/delete`, {
                    method: "POST",
                    headers: authHeaders(),
                    body: JSON.stringify({
                        pk: `CONTAINER#${activeShortContainerId.toUpperCase()}`,
                        sk: `PART#${editingItemId}#${partId}`,
                        attachmentId: att.attachmentId
                    })
                }).catch(e => console.warn("Could not delete part attachment:", e))
            ));
        }

        const res = await fetch(
            `${API}/containers/${activeShortContainerId}/items/${editingItemId}/parts/${partId}`,
            { method: "DELETE", headers: authHeaders() }
        );
        if (!res.ok) throw new Error(`Status: ${res.status}`);
        await loadParts();
        syncPartCountCell();
        showSuccessToast("Part deleted successfully.");
    } catch (err) {
        alert(`Failed to delete part: ${err.message}`);
    }
}

// ==========================================
// ADMIN USER MANAGEMENT
// ==========================================

let adminEditingLoginId = null;
let adminPasswordTargetLoginId = null;
let adminUsers = [];

function openAdminPanel() {
    if (!isAdmin) return;
    document.getElementById("adminModal").style.display = "flex";
    history.pushState({ view: 'app' }, '');
    loadAdminUsers();
    loadAdminSettings();
}

function closeAdminPanel() {
    document.getElementById("adminModal").style.display = "none";
}

async function loadAdminUsers() {
    const tbody = document.getElementById("adminUsersTableBody");
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="4" style="color:#888; font-style:italic;">Loading users...</td></tr>`;

    try {
        let users;
        if (window.APP_CONFIG?.USE_MOCK) {
            const res = await fetch('./mockdata/mock-admin-users.json');
            users = await res.json();
        } else {
            const res = await fetch(`${API}/admin/users`, { headers: authHeaders() });
            if (!checkAuthResponse(res)) return;
            if (!res.ok) throw new Error(`Status: ${res.status}`);
            users = await res.json();
        }
        adminUsers = Array.isArray(users) ? users : [];
        renderAdminUsers(adminUsers);
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" style="color:#c00;">Failed to load users: ${err.message}</td></tr>`;
    }
}

function renderAdminUsers(users) {
    const tbody = document.getElementById("adminUsersTableBody");
    if (!tbody) return;
    tbody.innerHTML = "";

    const currentLoginID = localStorage.getItem("userLoginID") || "";

    if (users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#888;">No users found.</td></tr>`;
        return;
    }

    users.forEach(u => {
        const isSelf = u.loginID === currentLoginID;
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${u.loginID}</strong>${isSelf ? ' <span style="font-size:11px; color:#888; font-weight:normal;">(you)</span>' : ''}</td>
            <td>${u.role}</td>
            <td>${u.active
                ? '<span style="color:#137333; font-weight:600;">Active</span>'
                : '<span style="color:#999;">Inactive</span>'
            }</td>
            <td style="white-space:nowrap; display:flex; gap:6px; flex-wrap:wrap;">
                <button onclick="openAdminEditUser('${u.loginID}','${u.role}',${!!u.active})"
                    style="padding:4px 10px; font-size:12px; min-height:28px; background:#0073bb; color:white; border:none; border-radius:4px; cursor:pointer;">Edit</button>
                <button onclick="openAdminPasswordModal('${u.loginID}')"
                    style="padding:4px 10px; font-size:12px; min-height:28px; background:#555; color:white; border:none; border-radius:4px; cursor:pointer;">Password</button>
                <button onclick="confirmAdminDeleteUser('${u.loginID}',${isSelf})"
                    style="padding:4px 10px; font-size:12px; min-height:28px; background:#ff4d4d; color:white; border:none; border-radius:4px; cursor:pointer;"
                    ${isSelf ? 'disabled title="Cannot delete your own account"' : ''}>Delete</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function openAdminUserForm() {
    adminEditingLoginId = null;
    document.getElementById("adminUserFormTitle").textContent = "Add User";
    document.getElementById("adminLoginId").value = "";
    document.getElementById("adminLoginId").disabled = false;
    document.getElementById("adminLoginIdGroup").style.display = "block";
    document.getElementById("adminRole").value = "USER";
    document.getElementById("adminActive").value = "true";
    document.getElementById("adminPassword").value = "";
    document.getElementById("adminPasswordGroup").style.display = "block";
    document.getElementById("adminPasswordConfirm").value = "";
    document.getElementById("adminPasswordConfirmGroup").style.display = "block";
    document.getElementById("adminUserFormModal").style.display = "flex";
    history.pushState({ view: 'app' }, '');
}

function openAdminEditUser(loginID, role, active) {
    adminEditingLoginId = loginID;
    document.getElementById("adminUserFormTitle").textContent = "Edit User";
    document.getElementById("adminLoginId").value = loginID;
    document.getElementById("adminLoginId").disabled = true;
    document.getElementById("adminLoginIdGroup").style.display = "block";
    document.getElementById("adminRole").value = role;
    document.getElementById("adminActive").value = active ? "true" : "false";
    document.getElementById("adminPasswordGroup").style.display = "none";
    document.getElementById("adminPasswordConfirmGroup").style.display = "none";
    document.getElementById("adminPassword").value = "";
    document.getElementById("adminPasswordConfirm").value = "";
    document.getElementById("adminUserFormModal").style.display = "flex";
    history.pushState({ view: 'app' }, '');
}

function closeAdminUserForm() {
    document.getElementById("adminUserFormModal").style.display = "none";
    adminEditingLoginId = null;
}

async function saveAdminUser() {
    const role = document.getElementById("adminRole").value;
    const active = document.getElementById("adminActive").value === "true";

    if (adminEditingLoginId) {
        if (window.APP_CONFIG?.USE_MOCK) {
            const idx = adminUsers.findIndex(u => u.loginID === adminEditingLoginId);
            if (idx !== -1) adminUsers[idx] = { ...adminUsers[idx], role, active };
            closeAdminUserForm();
            renderAdminUsers(adminUsers);
            showSuccessToast("User updated.");
            return;
        }
        try {
            const res = await fetch(`${API}/admin/users/${adminEditingLoginId}`, {
                method: "PUT",
                headers: authHeaders(),
                body: JSON.stringify({ role, active })
            });
            if (!checkAuthResponse(res)) return;
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || `Status: ${res.status}`);
            closeAdminUserForm();
            showSuccessToast("User updated successfully.");
            await loadAdminUsers();
        } catch (err) {
            alert(`Failed to update user: ${err.message}`);
        }
    } else {
        const loginID = document.getElementById("adminLoginId").value.trim();
        const password = document.getElementById("adminPassword").value;
        const confirmPassword = document.getElementById("adminPasswordConfirm").value;
        if (!loginID) { showInfoPopup("Login ID is required."); return; }
        if (!password) { showInfoPopup("Password is required."); return; }
        if (password.length < 6) { showInfoPopup("Password must be at least 6 characters."); return; }
        if (password !== confirmPassword) { showInfoPopup("Passwords do not match."); return; }

        if (window.APP_CONFIG?.USE_MOCK) {
            if (adminUsers.some(u => u.loginID === loginID)) { showInfoPopup("A user with this Login ID already exists."); return; }
            adminUsers.push({ loginID, role, active });
            closeAdminUserForm();
            renderAdminUsers(adminUsers);
            showSuccessToast("User created.");
            return;
        }
        try {
            const res = await fetch(`${API}/admin/users`, {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify({ loginID, password, role, active })
            });
            if (!checkAuthResponse(res)) return;
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || `Status: ${res.status}`);
            closeAdminUserForm();
            showSuccessToast("User created successfully.");
            await loadAdminUsers();
        } catch (err) {
            alert(`Failed to create user: ${err.message}`);
        }
    }
}

function openAdminPasswordModal(loginID) {
    adminPasswordTargetLoginId = loginID;
    document.getElementById("adminPwdTarget").textContent = `Changing password for: ${loginID}`;
    document.getElementById("adminNewPassword").value = "";
    document.getElementById("adminConfirmPassword").value = "";
    document.getElementById("adminPasswordModal").style.display = "flex";
    history.pushState({ view: 'app' }, '');
}

function closeAdminPasswordModal() {
    document.getElementById("adminPasswordModal").style.display = "none";
    adminPasswordTargetLoginId = null;
}

async function saveAdminPassword() {
    const newPwd = document.getElementById("adminNewPassword").value;
    const confirmPwd = document.getElementById("adminConfirmPassword").value;

    if (!newPwd) { showInfoPopup("New password is required."); return; }
    if (newPwd.length < 6) { showInfoPopup("Password must be at least 6 characters."); return; }
    if (newPwd !== confirmPwd) { showInfoPopup("Passwords do not match."); return; }

    if (window.APP_CONFIG?.USE_MOCK) {
        closeAdminPasswordModal();
        showSuccessToast("Password updated (mock mode — changes not persisted).");
        return;
    }

    try {
        const res = await fetch(`${API}/admin/users/${adminPasswordTargetLoginId}/password`, {
            method: "PUT",
            headers: authHeaders(),
            body: JSON.stringify({ password: newPwd })
        });
        if (!checkAuthResponse(res)) return;
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || `Status: ${res.status}`);
        closeAdminPasswordModal();
        showSuccessToast("Password updated successfully.");
    } catch (err) {
        alert(`Failed to update password: ${err.message}`);
    }
}

function confirmAdminDeleteUser(loginID, isSelf) {
    if (isSelf) { showInfoPopup("You cannot delete your own account."); return; }
    openDeleteModal("USER", loginID, loginID);
}

async function finalizeAdminUserDelete(loginID) {
    if (window.APP_CONFIG?.USE_MOCK) {
        adminUsers = adminUsers.filter(u => u.loginID !== loginID);
        renderAdminUsers(adminUsers);
        showSuccessToast("User deleted.");
        return;
    }

    try {
        const res = await fetch(`${API}/admin/users/${loginID}`, {
            method: "DELETE",
            headers: authHeaders()
        });
        if (!checkAuthResponse(res)) return;
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || `Status: ${res.status}`);
        showSuccessToast("User deleted successfully.");
        await loadAdminUsers();
    } catch (err) {
        alert(`Failed to delete user: ${err.message}`);
    }
}

// ==========================================
// SECTION: UPLOAD SETTINGS & FILE PROCESSING
// ==========================================

async function fetchUploadSettings() {
    try {
        let data;
        if (window.APP_CONFIG?.USE_MOCK) {
            const res = await fetch('./mockdata/mock-admin-settings.json');
            data = await res.json();
        } else {
            const res = await fetch(`${API}/settings`, { headers: authHeaders() });
            if (!res.ok) return;
            data = await res.json();
        }
        uploadSettings = { ...uploadSettings, ...data };
        applyContainerButtonVisibility();
    } catch (err) {
        console.warn("Could not load upload settings, using defaults.");
    }
}

function applyContainerButtonVisibility() {
    const show = uploadSettings.showContainerButtons !== false;
    const btnNew = document.getElementById("btnNewContainer");
    if (btnNew) btnNew.style.display = (isAdmin && show) ? "" : "none";

    const itemsPanel = document.getElementById("itemsPanelView");
    if (itemsPanel && itemsPanel.style.display !== "none" && isAdmin) {
        const btnEdit = document.getElementById("btnEditContainer");
        const btnDelete = document.getElementById("btnDeleteContainer");
        if (btnEdit) btnEdit.style.display = show ? "inline-block" : "none";
        if (btnDelete) btnDelete.style.display = show ? "inline-block" : "none";
    }
}

async function loadAdminSettings() {
    const pdfInput = document.getElementById("adminPdfSizeLimit");
    const compressionSelect = document.getElementById("adminImageCompressionEnabled");
    const containerBtnsToggle = document.getElementById("adminShowContainerButtons");
    if (!pdfInput || !compressionSelect) return;

    try {
        let data;
        if (window.APP_CONFIG?.USE_MOCK) {
            data = uploadSettings;
        } else {
            const res = await fetch(`${API}/settings`, { headers: authHeaders() });
            if (!res.ok) throw new Error(`Status: ${res.status}`);
            data = await res.json();
        }
        pdfInput.value = data.pdfSizeLimitMB ?? 5;
        compressionSelect.value = data.imageCompressionEnabled !== false ? "true" : "false";
        if (containerBtnsToggle) containerBtnsToggle.checked = data.showContainerButtons !== false;
    } catch (err) {
        console.error("Failed to load upload settings:", err);
    }
}

async function saveAdminSettings() {
    const pdfInput = document.getElementById("adminPdfSizeLimit");
    const compressionSelect = document.getElementById("adminImageCompressionEnabled");
    const containerBtnsToggle = document.getElementById("adminShowContainerButtons");

    const pdfSizeLimitMB = Number(pdfInput?.value);
    if (!pdfSizeLimitMB || pdfSizeLimitMB <= 0) { showInfoPopup("PDF size limit must be a positive number."); return; }

    const imageCompressionEnabled = compressionSelect?.value === "true";
    const showContainerButtons = containerBtnsToggle ? containerBtnsToggle.checked : true;
    const payload = { pdfSizeLimitMB, imageCompressionEnabled, showContainerButtons };

    if (window.APP_CONFIG?.USE_MOCK) {
        uploadSettings = payload;
        applyContainerButtonVisibility();
        showSuccessToast("Upload settings saved (mock mode).");
        return;
    }

    try {
        const res = await fetch(`${API}/admin/settings`, {
            method: "PUT",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (!checkAuthResponse(res)) return;
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || `Status: ${res.status}`);
        }
        uploadSettings = payload;
        applyContainerButtonVisibility();
        showSuccessToast("Upload settings saved.");
    } catch (err) {
        alert(`Failed to save settings: ${err.message}`);
    }
}

async function compressImage(file) {
    const TARGET_SIZE = 1 * 1024 * 1024; // 1 MB
    const MAX_DIMENSION = 2000;
    const MAX_QUALITY = 0.85;
    const MIN_QUALITY = 0.3;
    const QUALITY_STEP = 0.1;

    if (file.size <= TARGET_SIZE) return file;

    return new Promise((resolve) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);

        img.onload = () => {
            URL.revokeObjectURL(objectUrl);

            let { width, height } = img;
            if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
                const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
                width = Math.round(width * ratio);
                height = Math.round(height * ratio);
            }

            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            canvas.getContext("2d").drawImage(img, 0, 0, width, height);

            let quality = MAX_QUALITY;

            const tryCompress = () => {
                canvas.toBlob((blob) => {
                    if (!blob) return resolve(file);

                    if (blob.size <= TARGET_SIZE || quality <= MIN_QUALITY) {
                        const compressedName = file.name.replace(/\.[^.]+$/, ".jpg");
                        resolve(new File([blob], compressedName, { type: "image/jpeg" }));
                    } else {
                        quality = Math.max(MIN_QUALITY, parseFloat((quality - QUALITY_STEP).toFixed(2)));
                        tryCompress();
                    }
                }, "image/jpeg", quality);
            };

            tryCompress();
        };

        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(file); // fall back to original if image fails to load
        };

        img.src = objectUrl;
    });
}

async function checkAndPrepareFile(file, progressEl) {
    const isPDF = file.type === "application/pdf";
    const isImage = file.type.startsWith("image/");

    if (isPDF) {
        const limitBytes = (uploadSettings.pdfSizeLimitMB || 5) * 1024 * 1024;
        if (file.size > limitBytes) {
            const sizeMB = (file.size / 1024 / 1024).toFixed(1);
            const proceed = await showConfirmPopup(
                `"${file.name}" is ${sizeMB} MB, which exceeds the ${uploadSettings.pdfSizeLimitMB} MB PDF limit. Upload anyway?`,
                "File Size Warning"
            );
            if (!proceed) return null;
        }
        return file;
    }

    if (isImage && uploadSettings.imageCompressionEnabled) {
        if (progressEl) progressEl.innerText = "⏳ Compressing image...";
        return await compressImage(file);
    }

    return file;
}