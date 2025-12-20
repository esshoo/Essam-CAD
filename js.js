import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// --- Global Variables ---
let camera, scene, renderer, controls;
let roomGroup, snapPoints = [];
let dolly;
let settings = { height: 3.0, thickness: 0.20 };
let parsedDxf = null;

let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();

let isMeasuring = false;
let measureStartPoint = new THREE.Vector3();
let savedMeasurements = [];
let activeLine, activeLabel;
let snapSphere;

let touchTimer = null;
let isTouchDragging = false;
let mobileCrosshair = document.getElementById('mobile-crosshair');

let controller1, controller2;
let teleportMarker;
let activeController = null;
let isTeleporting = false;
let controllerState = { rightA: false }; 

// --- UI Logic ---
window.switchTab = (tabName) => {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + tabName).classList.add('active');
    const btnIndex = tabName === 'upload' ? 0 : 1;
    document.querySelectorAll('.tab-btn')[btnIndex].classList.add('active');
};

window.handleFileUpload = () => {
    const fileInput = document.getElementById('fileInput');
    if (fileInput.files.length === 0) { alert("يرجى اختيار ملف DXF"); return; }
    settings.height = parseFloat(document.getElementById('wallHeight').value);
    settings.thickness = parseFloat(document.getElementById('wallThick').value) / 100;
    document.getElementById('loader').style.display = 'block';
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const parser = new window.DxfParser();
            parsedDxf = parser.parseSync(e.target.result);
            document.getElementById('loader').style.display = 'none';
            showLayerModal(parsedDxf);
        } catch(err) {
            alert("خطأ في قراءة الملف: " + err);
            document.getElementById('loader').style.display = 'none';
        }
    };
    reader.readAsText(fileInput.files[0]);
};

window.loadDemo = () => {
    document.getElementById('loader').style.display = 'block';
    settings.height = 5.8;
    fetch('room.dxf').then(res => res.ok ? res.text() : Promise.reject("ملف room.dxf غير موجود"))
        .then(text => {
            const parser = new window.DxfParser();
            parsedDxf = parser.parseSync(text);
            document.getElementById('loader').style.display = 'none';
            showLayerModal(parsedDxf);
        }).catch(err => alert(err));
};

// --- Layer Logic with Custom Color Palette ---
function showLayerModal(dxf) {
    const layerSet = new Set();
    dxf.entities.forEach(e => { if(e.layer) layerSet.add(e.layer); });
    
    const container = document.getElementById('layerListContainer');
    container.innerHTML = ''; 

    // ألوان جاهزة للعرض (لتجنب مشاكل Color Picker في النظارة)
    const palette = ['#e91e63', '#9c27b0', '#2196f3', '#00bcd4', '#4caf50', '#ffeb3b', '#ff9800', '#ffffff', '#000000'];

    layerSet.forEach(layerName => {
        const item = document.createElement('div');
        item.className = 'layer-item';
        
        const lower = layerName.toLowerCase();
        let defType = 'hide';
        let defVal = 0; 
        let defColor = '#ffffff';
        let isGlass = false;

        if(lower.includes('wall') || lower.includes('bina')) {
            defType = 'wall'; defColor = '#e91e63';
            if(lower.includes('glass')) { isGlass = true; defColor = '#00bcd4'; }
        }
        else if(lower.includes('beam') || lower.includes('kamara')) { 
            defType = 'ceil'; defVal = 0.5; defColor = '#ffffff'; 
        }
        else if(lower.includes('light') || lower.includes('ceil')) { 
            defType = 'ceil'; defVal = 0; defColor = '#ffeb3b'; 
        }
        else if(lower.includes('socket')) { 
            defType = 'floor'; defVal = 0.4; defColor = '#4caf50'; 
        }
        else if(lower.includes('switch')) { 
            defType = 'floor'; defVal = 1.2; defColor = '#9c27b0'; 
        }
        else if(lower.includes('furn') || lower.includes('floor')) { 
            defType = 'floor'; defVal = 0; defColor = '#ffffff'; 
        }

        // إنشاء باليت الألوان HTML
        let paletteHTML = `<div class="color-palette" id="palette-${layerName}">`;
        palette.forEach(c => {
            const isSelected = (c.toLowerCase() === defColor.toLowerCase()) ? 'selected' : '';
            paletteHTML += `<div class="color-swatch ${isSelected}" style="background:${c}" onclick="selectColor('${layerName}', '${c}', this)"></div>`;
        });
        paletteHTML += `</div>`;
        // Input مخفي لتخزين اللون المختار
        paletteHTML += `<input type="hidden" id="color-input-${layerName}" value="${defColor}">`;

        item.innerHTML = `
            <div class="layer-name">${layerName}</div>
            <div class="layer-controls">
                <select class="layer-select ${getSelectClass(defType)}" 
                        data-layer="${layerName}" id="type-${layerName}"
                        onchange="updateLayerRow(this)">
                    <option value="wall" ${defType==='wall'?'selected':''}>🧱 حوائط</option>
                    <option value="ceil" ${defType==='ceil'?'selected':''}>🏗️ سقف / كمرات</option>
                    <option value="floor" ${defType==='floor'?'selected':''}>🛋️ أرضية / عام</option>
                    <option value="hide" ${defType==='hide'?'selected':''}>👁️‍🗨️ إخفاء</option>
                </select>
                
                <input type="number" step="0.1" class="layer-input" id="val-${layerName}" value="${defVal}" placeholder="م" title="الارتفاع/السقوط">
                
                ${paletteHTML}
                
                <label class="glass-check" title="شفافية (زجاج)">
                    <input type="checkbox" id="glass-${layerName}" ${isGlass?'checked':''}> 🧊
                </label>
            </div>
        `;
        container.appendChild(item);
    });
    
    document.getElementById('layer-modal').style.display = 'flex';
}

window.selectColor = (layerName, color, el) => {
    // تحديث القيمة المخفية
    document.getElementById(`color-input-${layerName}`).value = color;
    // تحديث الشكل (Selected border)
    const container = document.getElementById(`palette-${layerName}`);
    Array.from(container.children).forEach(child => child.classList.remove('selected'));
    el.classList.add('selected');
};

function getSelectClass(type) {
    if(type === 'wall') return 'opt-wall';
    if(type === 'ceil') return 'opt-line'; 
    if(type === 'floor') return 'opt-line';
    return 'opt-hide';
}

window.updateLayerRow = (select) => {
    select.className = 'layer-select ' + getSelectClass(select.value);
};

window.processLayersAndBuild = () => {
    const layerConfig = {};
    const selects = document.querySelectorAll('.layer-select');
    
    selects.forEach(sel => {
        const name = sel.getAttribute('data-layer');
        layerConfig[name] = {
            type: sel.value,
            value: parseFloat(document.getElementById(`val-${name}`).value) || 0, 
            color: document.getElementById(`color-input-${name}`).value, // قراءة اللون من Input المخفي
            isGlass: document.getElementById(`glass-${name}`).checked
        };
    });

    document.getElementById('layer-modal').style.display = 'none';
    init3DScene(parsedDxf, layerConfig);
};

// --- 3D Scene Initialization ---
function init3DScene(dxf, layerConfig) {
    document.getElementById('landing-page').style.display = 'none';
    document.getElementById('ui-controls').style.display = 'flex';

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x222222);

    dolly = new THREE.Group();
    scene.add(dolly);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 15, 15);
    dolly.add(camera);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    document.body.appendChild(renderer.domElement);
    document.body.appendChild(VRButton.createButton(renderer));

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);
    
    // --- Floor ---
    const grid = new THREE.GridHelper(100, 100, 0x444444, 0x222222);
    scene.add(grid);
    const floorGeo = new THREE.PlaneGeometry(200, 200);
    const floorMat = new THREE.MeshBasicMaterial({ visible: false });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.name = "floor";
    scene.add(floor);

    // --- Ceiling Helper (السقف الشبكي) ---
    // إنشاء شبكة سقف مماثلة للأرضية لكن عند الارتفاع المحدد
    const ceilGrid = new THREE.GridHelper(100, 100, 0x444444, 0x222222);
    ceilGrid.position.y = settings.height;
    scene.add(ceilGrid);

    // إنشاء "غطاء" أسود شفاف للسقف ليعطي إحساس الغرفة المغلقة
    const ceilPlaneGeo = new THREE.PlaneGeometry(200, 200);
    const ceilPlaneMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const ceilPlane = new THREE.Mesh(ceilPlaneGeo, ceilPlaneMat);
    ceilPlane.rotation.x = -Math.PI / 2;
    ceilPlane.position.y = settings.height + 0.01; // نرفعه شعرة عن الشبكة لمنع التداخل
    scene.add(ceilPlane);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.zoomSpeed = 0.5;
    controls.maxDistance = 200;
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };

    // Snapping Setup
    const snapGeo = new THREE.SphereGeometry(0.1, 16, 16);
    const snapMat = new THREE.MeshBasicMaterial({ color: 0xffff00, depthTest: false, transparent: true });
    snapSphere = new THREE.Mesh(snapGeo, snapMat);
    snapSphere.visible = false;
    snapSphere.renderOrder = 999;
    scene.add(snapSphere);

    // Tools
    const lineMat = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2, depthTest: false });
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    activeLine = new THREE.Line(lineGeo, lineMat);
    activeLine.frustumCulled = false;
    activeLine.visible = false;
    activeLine.renderOrder = 998;
    scene.add(activeLine);

    activeLabel = createTextSprite("0.00m");
    activeLabel.visible = false;
    scene.add(activeLabel);

    setupVRControllers();

    buildSceneFromLayers(dxf, layerConfig);
    loadFromLocalStorage();

    window.addEventListener('resize', onResize);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('touchstart', onTouchStart, {passive: false});
    renderer.domElement.addEventListener('touchmove', onTouchMove, {passive: false});
    renderer.domElement.addEventListener('touchend', onTouchEnd);

    renderer.setAnimationLoop(render);
}

function buildSceneFromLayers(dxf, layerConfig) {
    roomGroup = new THREE.Group();
    snapPoints = [];
    
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    dxf.entities.forEach(e => {
        if((e.type === 'LINE' || e.type === 'LWPOLYLINE') && e.vertices) {
             e.vertices.forEach(v => {
                 if(v.x < minX) minX = v.x; if(v.x > maxX) maxX = v.x;
                 if(v.y < minY) minY = v.y; if(v.y > maxY) maxY = v.y;
             });
        }
    });
    if(minX === Infinity) { minX=0; maxX=0; minY=0; maxY=0; }
    
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const materialsCache = {};

    dxf.entities.forEach(e => {
        const config = layerConfig[e.layer];
        if(!config || config.type === 'hide') return;

        const matKey = e.layer + config.color; // المفتاح يشمل اللون لضمان التنوع
        if(!materialsCache[matKey]) {
            if(config.type === 'wall' || (config.type === 'ceil' && config.value > 0)) {
                materialsCache[matKey] = new THREE.MeshStandardMaterial({ 
                    color: config.color, 
                    side: THREE.DoubleSide,
                    transparent: config.isGlass,
                    opacity: config.isGlass ? 0.3 : 1.0,
                    roughness: config.isGlass ? 0.1 : 0.8
                });
            } else {
                materialsCache[matKey] = new THREE.LineBasicMaterial({ color: config.color });
            }
        }
        const material = materialsCache[matKey];

        if (e.type === 'LINE') {
            processEntity(e.vertices[0], e.vertices[1], cx, cy, config, material);
        } else if (e.type === 'LWPOLYLINE') {
            for(let i=0; i<e.vertices.length-1; i++) {
                processEntity(e.vertices[i], e.vertices[i+1], cx, cy, config, material);
            }
            if(e.shape) processEntity(e.vertices[e.vertices.length-1], e.vertices[0], cx, cy, config, material);
        }
    });

    scene.add(roomGroup);
    controls.target.set(0, 0, 0);
    controls.update();
}

function processEntity(p1, p2, cx, cy, config, material) {
    const x1 = p1.x - cx; const z1 = -(p1.y - cy);
    const x2 = p2.x - cx; const z2 = -(p2.y - cy);

    // 1. حوائط
    if (config.type === 'wall') {
        const v1 = new THREE.Vector3(x1, settings.height/2, z1);
        const v2 = new THREE.Vector3(x2, settings.height/2, z2);
        const dist = Math.sqrt(Math.pow(x1-x2,2) + Math.pow(z1-z2,2));
        
        if(dist > 0.05) {
            const geo = new THREE.BoxGeometry(settings.thickness, settings.height, dist);
            const wall = new THREE.Mesh(geo, material);
            wall.position.copy(v1.clone().add(v2).multiplyScalar(0.5));
            wall.lookAt(v2);
            roomGroup.add(wall);
            snapPoints.push(new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x1, settings.height, z1));
            snapPoints.push(new THREE.Vector3(x2, 0, z2), new THREE.Vector3(x2, settings.height, z2));
        }
    } 
    // 2. سقف (كمرات أو خطوط)
    else if (config.type === 'ceil') {
        if (config.value > 0) { // كمرة ساقطة
            const beamHeight = config.value;
            const centerY = settings.height - (beamHeight / 2);
            const v1 = new THREE.Vector3(x1, centerY, z1);
            const v2 = new THREE.Vector3(x2, centerY, z2);
            const dist = Math.sqrt(Math.pow(x1-x2,2) + Math.pow(z1-z2,2));

            if(dist > 0.05) {
                const geo = new THREE.BoxGeometry(settings.thickness, beamHeight, dist);
                const beam = new THREE.Mesh(geo, material);
                beam.position.copy(v1.clone().add(v2).multiplyScalar(0.5));
                beam.lookAt(v2);
                roomGroup.add(beam);
                snapPoints.push(new THREE.Vector3(x1, settings.height - beamHeight, z1));
                snapPoints.push(new THREE.Vector3(x2, settings.height - beamHeight, z2));
            }
        } else { // خط في السقف
            const y = settings.height;
            const points = [new THREE.Vector3(x1, y, z1), new THREE.Vector3(x2, y, z2)];
            const geo = new THREE.BufferGeometry().setFromPoints(points);
            const line = new THREE.Line(geo, material);
            roomGroup.add(line);
            snapPoints.push(points[0], points[1]);
        }
    }
    // 3. أرضية
    else if (config.type === 'floor') {
        const y = config.value > 0 ? config.value : 0.05;
        const points = [new THREE.Vector3(x1, y, z1), new THREE.Vector3(x2, y, z2)];
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geo, material);
        roomGroup.add(line);
        snapPoints.push(points[0], points[1]);
    }
}

// --- Helper Functions (No Changes) ---
function createTextSprite(message, color = "#00ff00") {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256; canvas.height = 128;
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(0,0, 256, 128);
    ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.strokeRect(0,0, 256, 128);
    ctx.font = "Bold 40px Arial"; ctx.fillStyle = "white"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(message, 128, 64);
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(1, 0.5, 1);
    sprite.renderOrder = 1000;
    return sprite;
}

function updateLabelText(sprite, text, color="#00ff00") {
    const canvas = sprite.material.map.image;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,256,128);
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(0,0, 256, 128);
    ctx.strokeStyle = color; ctx.strokeRect(0,0, 256, 128);
    ctx.font = "Bold 40px Arial"; ctx.fillStyle = "white"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 64);
    sprite.material.map.needsUpdate = true;
}

function getClosestPoint(targetPoint, threshold = 0.5) {
    let closest = null, minDst = threshold;
    for(let p of snapPoints) {
        const d = p.distanceTo(targetPoint);
        if(d < minDst) { minDst = d; closest = p.clone(); }
    }
    return closest ? closest : targetPoint;
}

function onPointerMove(event) {
    if(renderer.xr.isPresenting || event.pointerType === 'touch') return;
    updateRaycaster(event.clientX, event.clientY);
    handleHoverAndSnap();
    if(isMeasuring) updateActiveMeasurement(snapSphere.position);
}

function onPointerDown(event) {
    if(renderer.xr.isPresenting || event.pointerType === 'touch') return;
    if (event.button === 0) startMeasurement(snapSphere.position);
}

function onPointerUp(event) {
     if(renderer.xr.isPresenting || event.pointerType === 'touch') return;
     if (event.button === 0 && isMeasuring) endMeasurement(snapSphere.position);
}

function onTouchStart(e) {
    if(e.touches.length > 1) {
        clearTimeout(touchTimer); isTouchDragging = false; controls.enabled = true; mobileCrosshair.style.display = 'none'; return;
    }
    touchTimer = setTimeout(() => {
        isTouchDragging = true; controls.enabled = false;
        mobileCrosshair.style.display = 'flex';
        mobileCrosshair.style.left = e.touches[0].clientX + 'px';
        mobileCrosshair.style.top = (e.touches[0].clientY - 70) + 'px';
        const tX = e.touches[0].clientX, tY = e.touches[0].clientY - 70;
        updateRaycaster(tX, tY); handleHoverAndSnap();
    }, 400);
}

function onTouchMove(e) {
    if(isTouchDragging) {
        e.preventDefault();
        const tX = e.touches[0].clientX, tY = e.touches[0].clientY - 70;
        mobileCrosshair.style.left = e.touches[0].clientX + 'px';
        mobileCrosshair.style.top = tY + 'px';
        updateRaycaster(tX, tY); handleHoverAndSnap();
        if(isMeasuring) updateActiveMeasurement(snapSphere.position);
    } else clearTimeout(touchTimer);
}

function onTouchEnd(e) {
    clearTimeout(touchTimer); mobileCrosshair.style.display = 'none'; controls.enabled = true;
    if(isTouchDragging) {
        isTouchDragging = false;
        if(!isMeasuring) startMeasurement(snapSphere.position);
        else endMeasurement(snapSphere.position);
    }
}

function updateRaycaster(x, y) {
    mouse.x = (x / window.innerWidth) * 2 - 1;
    mouse.y = -(y / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
}

function handleHoverAndSnap() {
    if(!roomGroup) return;
    const intersects = raycaster.intersectObjects(roomGroup.children);
    let target = null;
    if (intersects.length > 0) target = intersects[0].point;
    else {
        const floorInt = raycaster.intersectObject(scene.getObjectByName('floor'));
        if(floorInt.length > 0) target = floorInt[0].point;
    }

    if(target) {
        const snapped = getClosestPoint(target, 0.4);
        snapSphere.position.copy(snapped);
        snapSphere.visible = true;
        snapSphere.material.color.setHex(snapped === target ? 0xffff00 : 0xff0000);
    } else snapSphere.visible = false;
}

function startMeasurement(point) {
    isMeasuring = true;
    measureStartPoint.copy(point);
    activeLine.geometry.setFromPoints([point, point]);
    activeLine.visible = true;
    activeLabel.visible = true;
    activeLabel.position.copy(point).add(new THREE.Vector3(0, 0.2, 0));
    updateLabelText(activeLabel, "0.00m");
}

function updateActiveMeasurement(currentPoint) {
    activeLine.geometry.setFromPoints([measureStartPoint, currentPoint]);
    activeLine.geometry.attributes.position.needsUpdate = true;
    const dist = measureStartPoint.distanceTo(currentPoint);
    const mid = new THREE.Vector3().addVectors(measureStartPoint, currentPoint).multiplyScalar(0.5);
    activeLabel.position.copy(mid).add(new THREE.Vector3(0, 0.2, 0));
    updateLabelText(activeLabel, dist.toFixed(2) + "m");
}

function endMeasurement(endPoint) {
    if(!isMeasuring) return;
    createPermanentMeasurement(measureStartPoint, endPoint);
    isMeasuring = false;
    activeLine.visible = false;
    activeLabel.visible = false;
    saveToLocalStorage();
}

function createPermanentMeasurement(p1, p2) {
    const lineMat = new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 2, depthTest: false });
    const lineGeo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const line = new THREE.Line(lineGeo, lineMat);
    scene.add(line);
    const dist = p1.distanceTo(p2);
    const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
    const label = createTextSprite(dist.toFixed(2) + "m", "#00ffff");
    label.position.copy(mid).add(new THREE.Vector3(0, 0.2, 0));
    scene.add(label);
    savedMeasurements.push({ start: p1.clone(), end: p2.clone(), distance: dist, line: line, label: label });
}

window.undoLastMeasurement = () => {
    if (savedMeasurements.length === 0) return;
    const last = savedMeasurements.pop();
    scene.remove(last.line); scene.remove(last.label);
    last.line.geometry.dispose(); last.line.material.dispose();
    last.label.material.map.dispose(); last.label.material.dispose();
    saveToLocalStorage();
};

window.exportMeasurements = () => {
    const data = savedMeasurements.map(m => ({ start: m.start, end: m.end, distance: m.distance }));
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = "measurements.json"; a.click();
};

window.importMeasurements = (input) => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            while(savedMeasurements.length > 0) window.undoLastMeasurement();
            data.forEach(m => { createPermanentMeasurement(new THREE.Vector3(m.start.x, m.start.y, m.start.z), new THREE.Vector3(m.end.x, m.end.y, m.end.z)); });
            saveToLocalStorage();
        } catch(err) { alert("ملف خاطئ"); }
    };
    reader.readAsText(file);
};

function saveToLocalStorage() {
    const data = savedMeasurements.map(m => ({ start: m.start, end: m.end, distance: m.distance }));
    localStorage.setItem('dxf_measurements', JSON.stringify(data));
}

function loadFromLocalStorage() {
    const stored = localStorage.getItem('dxf_measurements');
    if (stored) {
        try {
            const data = JSON.parse(stored);
            data.forEach(m => { createPermanentMeasurement(new THREE.Vector3(m.start.x, m.start.y, m.start.z), new THREE.Vector3(m.end.x, m.end.y, m.end.z)); });
        } catch (e) { console.log("خطأ في استرجاع البيانات"); }
    }
}

function setupVRControllers() {
    const markerGeo = new THREE.RingGeometry(0.1, 0.2, 32).rotateX(-Math.PI / 2);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0x00aaff });
    teleportMarker = new THREE.Mesh(markerGeo, markerMat);
    teleportMarker.visible = false;
    scene.add(teleportMarker);

    controller1 = renderer.xr.getController(0);
    controller2 = renderer.xr.getController(1);

    const setupEvt = (ctlr) => {
        ctlr.addEventListener('selectstart', onVRTriggerStart);
        ctlr.addEventListener('squeezestart', onVRGripStart);
        ctlr.addEventListener('squeezeend', onVRGripEnd);
        ctlr.add(new THREE.Line( new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,-5)]), new THREE.LineBasicMaterial({ color: 0xffffff }) ));
        dolly.add(ctlr);
    };
    setupEvt(controller1);
    setupEvt(controller2);

    const controllerModelFactory = new XRControllerModelFactory();
    const grip1 = renderer.xr.getControllerGrip(0);
    grip1.add(controllerModelFactory.createControllerModel(grip1));
    const grip2 = renderer.xr.getControllerGrip(1);
    grip2.add(controllerModelFactory.createControllerModel(grip2));
    dolly.add(grip1, grip2);
}

function onVRTriggerStart(event) {
    activeController = event.target;
    if(!isMeasuring) startMeasurement(snapSphere.position);
    else endMeasurement(snapSphere.position);
}

function onVRGripStart(event) {
    isTeleporting = true;
    activeController = event.target;
    teleportMarker.visible = true;
}

function onVRGripEnd(event) {
    if(isTeleporting && teleportMarker.visible) dolly.position.copy(teleportMarker.position);
    isTeleporting = false;
    teleportMarker.visible = false;
}

function handleVRUpdate() {
    if(!activeController) return;
    const tempMatrix = new THREE.Matrix4();
    tempMatrix.identity().extractRotation(activeController.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(activeController.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    if(isTeleporting) {
        const floorInt = raycaster.intersectObject(scene.getObjectByName('floor'));
        if(floorInt.length > 0) teleportMarker.position.copy(floorInt[0].point);
        else teleportMarker.visible = false;
    } else {
        handleHoverAndSnap();
        if(isMeasuring) updateActiveMeasurement(snapSphere.position);
    }
    
    // Undo logic
    const session = renderer.xr.getSession();
    if (session) {
        for (const source of session.inputSources) {
            if (source.handedness === 'right' && source.gamepad && source.gamepad.buttons.length > 4) {
                const aButton = source.gamepad.buttons[4];
                if (aButton.pressed && !controllerState.rightA) {
                    window.undoLastMeasurement();
                    controllerState.rightA = true;
                } else if (!aButton.pressed) {
                    controllerState.rightA = false;
                }
            }
        }
    }
}

function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function render() {
    if(renderer.xr.isPresenting) handleVRUpdate();
    else controls.update();
    renderer.render(scene, camera);
}