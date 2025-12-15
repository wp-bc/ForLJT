import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

// ==========================================
// 1. 照片和音乐路径配置
// ==========================================
const PRELOAD_PHOTOS = [
    './photos/1.jpg',
    './photos/2.jpg',
    './photos/3.jpg',
    './photos/4.jpg',
    './photos/5.jpg',
    './photos/7.jpg',
    './photos/8.jpg',
    './photos/9.jpg',
    './photos/10.jpg',
    './photos/11.jpg',
    './photos/12.jpg'
];

const PRELOAD_MUSIC = './music/ms.mp3';

const CONFIG = {
    colors: { bg: 0x000000, champagneGold: 0xffd966, deepGreen: 0x03180a, accentRed: 0x990000 },
    particles: { count: 3000, dustCount: 5000, treeHeight: 24, treeRadius: 8 },
    // 【新增】下落氛围配置
    falling: { 
        count: 1000,        // 雪花和星星的总数
        speed: 2.5,        // 下落速度
        rangeX: 60,        // 水平分布范围
        rangeZ: 30,        // 前后分布范围
        topY: 40,          // 生成高度（顶部）
        bottomY: -20       // 消失高度（底部）
    },
    camera: { z: 50 },
    interaction: { rotationSpeed: 1.4, grabRadius: 0.55 }
};

const STATE = {
    mode: 'TREE', focusTarget: null,
    focusType: 0,
    hand: { detected: false, x: 0, y: 0 },
    rotation: { x: 0, y: 0 },
    uiVisible: false, cameraVisible: true
};

const FONT_STYLES = {
    'style1': { font: "'Ma Shan Zheng', cursive", spacing: "4px", shadow: "2px 2px 8px rgba(180,50,50,0.8)", transform: "none", weight: "normal" },
    'style2': { font: "'Cinzel', serif", spacing: "6px", shadow: "0 0 20px rgba(255,215,0,0.5)", transform: "uppercase", weight: "700" },
    'style3': { font: "'Great Vibes', cursive", spacing: "1px", shadow: "0 0 15px rgba(255,200,255,0.7)", transform: "none", weight: "normal" },
    'style4': { font: "'Monoton', cursive", spacing: "1px", shadow: "0 0 10px #fff, 0 0 20px #f0f", transform: "uppercase", weight: "normal" },
    'style5': { font: "'Abril Fatface', cursive", spacing: "0px", shadow: "0 5px 15px rgba(0,0,0,0.8)", transform: "none", weight: "normal" }
};

// --- IndexedDB (用于存储用户手动上传的数据) ---
const DB_NAME = "GrandTreeDB_v16";
let db;

function initDB() {
    return new Promise((resolve) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: "id" });
            if (!db.objectStoreNames.contains('music')) db.createObjectStore('music', { keyPath: "id" });
        };
        request.onsuccess = (e) => { db = e.target.result; resolve(db); };
        request.onerror = () => resolve(null);
    });
}

function savePhotoToDB(base64) {
    if(!db) return null;
    const tx = db.transaction('photos', "readwrite");
    const id = Date.now() + Math.random().toString();
    tx.objectStore('photos').add({ id: id, data: base64 });
    return id;
}
function loadPhotosFromDB() {
    if(!db) return Promise.resolve([]);
    return new Promise((r) => {
        db.transaction('photos', "readonly").objectStore('photos').getAll().onsuccess = (e) => r(e.target.result);
    });
}
function deletePhotoFromDB(id) { if(db) db.transaction('photos', "readwrite").objectStore('photos').delete(id); }
function clearPhotosDB() { if(db) db.transaction('photos', "readwrite").objectStore('photos').clear(); }

function saveMusicToDB(blob) {
    if(!db) return;
    const tx = db.transaction('music', "readwrite");
    tx.objectStore('music').put({ id: 'bgm', data: blob });
}
function loadMusicFromDB() {
    if(!db) return Promise.resolve(null);
    return new Promise((r) => {
        db.transaction('music', "readonly").objectStore('music').get('bgm').onsuccess = (e) => r(e.target.result ? e.target.result.data : null);
    });
}

// 全局变量
let scene, camera, renderer, composer;
let mainGroup, particleSystem = [], photoMeshGroup = new THREE.Group();
// 【新增】独立的下落氛围组和纹理变量
let fallingGroup = new THREE.Group(); 
let fallingSystem = []; 
let bgTexture = null; 

let clock = new THREE.Clock();
let handLandmarker, videoElement;
let caneTexture;
let bgmAudio = new Audio(); bgmAudio.loop = true; let isMusicPlaying = false;

// 加载并尝试自动播放音乐
function loadStaticMusic() {
    bgmAudio.src = PRELOAD_MUSIC; 
    bgmAudio.loop = true; 

    bgmAudio.play().then(() => {
        isMusicPlaying = true;
        updatePlayBtnUI(true);
    }).catch((error) => {
        console.log("浏览器限制自动播放，等待用户点击...");
        const startMusicOnClick = () => {
            bgmAudio.play();
            isMusicPlaying = true;
            updatePlayBtnUI(true);
            window.removeEventListener('click', startMusicOnClick);
            window.removeEventListener('keydown', startMusicOnClick);
            window.removeEventListener('touchstart', startMusicOnClick);
        };
        window.addEventListener('click', startMusicOnClick);
        window.addEventListener('keydown', startMusicOnClick);
        window.addEventListener('touchstart', startMusicOnClick);
    });
}

async function init() {
    initThree();
    setupEnvironment();
    setupLights();
    createTextures();
    createParticles();
    createDust();
    
    // 【新增】创建垂直下落的雪花和星光
    createFallingAtmosphere();

    loadStaticPhotos(); 
    loadStaticMusic(); 
    
    setupPostProcessing();
    setupEvents();
    animate();

    const loader = document.getElementById('loader');
    if(loader) { loader.style.opacity = 0; setTimeout(() => loader.remove(), 500); }

    try {
        await initDB();
        loadTextConfig(); 

        const savedPhotos = await loadPhotosFromDB();
        if(savedPhotos && savedPhotos.length > 0) {
             savedPhotos.forEach(item => createPhotoTexture(item.data, item.id));
        }

        const savedMusic = await loadMusicFromDB();
        if(savedMusic) {
            bgmAudio.src = URL.createObjectURL(savedMusic);
            updatePlayBtnUI(false);
        }

    } catch(e) { console.warn("Init Warning", e); }

    initMediaPipe();
    initDraggableTitle();
}

function loadStaticPhotos() {
    PRELOAD_PHOTOS.forEach((path, index) => {
        const img = new Image();
        img.src = path;
        img.onload = () => {
            const tex = new THREE.Texture(img);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.needsUpdate = true;
            addPhotoToScene(tex, 'static_' + index, path);
        };
        img.onerror = () => {
            console.warn("照片加载失败，请检查路径:", path);
        };
    });
}

function initDraggableTitle() {
    const title = document.getElementById('title-container');
    let isDragging = false;
    let offset = { x: 0, y: 0 };
    title.addEventListener('mousedown', (e) => {
        isDragging = true;
        const rect = title.getBoundingClientRect();
        offset.x = e.clientX - rect.left; offset.y = e.clientY - rect.top;
        title.style.transform = 'none'; title.style.left = rect.left + 'px'; title.style.top = rect.top + 'px';
    });
    window.addEventListener('mousemove', (e) => {
        if(isDragging) { title.style.left = (e.clientX - offset.x) + 'px'; title.style.top = (e.clientY - offset.y) + 'px'; }
    });
    window.addEventListener('mouseup', () => { isDragging = false; });
}

window.toggleUI = function() {
    STATE.uiVisible = !STATE.uiVisible;
    const tl = document.querySelector('#left-sidebar'); // 注意：这里建议改用ID选择器控制整个侧边栏
    const bl = document.querySelector('.bottom-left-panel');
    const btn = document.getElementById('toggle-ui-btn');
    
    if(!STATE.uiVisible) {
        // 隐藏
        tl.classList.add('panel-hidden'); 
        bl.classList.add('panel-hidden'); 
        btn.innerText = "👁 显示界面";
    } else {
        // 显示
        tl.classList.remove('panel-hidden'); 
        bl.classList.remove('panel-hidden'); 
        btn.innerText = "👁 隐藏界面";
    }
}

window.toggleCameraDisplay = function() {
    STATE.cameraVisible = !STATE.cameraVisible;
    const cam = document.getElementById('webcam-wrapper');
    if(STATE.cameraVisible) cam.classList.remove('camera-hidden'); else cam.classList.add('camera-hidden');
}

window.toggleFullScreen = function() {
    const btn = document.getElementById('fs-btn');
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
        btn.innerText = "⛶ 退出全屏";
    } else {
        document.exitFullscreen();
        btn.innerText = "⛶ 全屏显示";
    }
}
document.addEventListener('fullscreenchange', () => {
    const btn = document.getElementById('fs-btn');
    if (!document.fullscreenElement) btn.innerText = "⛶ 全屏显示";
    else btn.innerText = "⛶ 退出全屏";
});

function loadTextConfig() {
    const saved = JSON.parse(localStorage.getItem('v16_text_config'));
    if(saved) {
        document.getElementById('input-line1').value = saved.line1 || "";
        document.getElementById('input-line2').value = saved.line2 || "";
        document.getElementById('font-select').value = saved.fontKey || "style1";
        document.getElementById('slider-fontsize').value = saved.size || 100;
        document.getElementById('color-picker').value = saved.color || "#fceea7";
        applyTextConfig(saved.fontKey, saved.line1, saved.line2, saved.size, saved.color);
    } else {
        document.getElementById('input-line1').value = "Merry"; document.getElementById('input-line2').value = "Christmas";
        applyTextConfig("style1", "Merry", "Christmas", 100, "#fceea7");
    }
}

window.updateTextConfig = function() {
    const key = document.getElementById('font-select').value;
    const l1 = document.getElementById('input-line1').value;
    const l2 = document.getElementById('input-line2').value;
    const s = document.getElementById('slider-fontsize').value;
    const c = document.getElementById('color-picker').value;
    localStorage.setItem('v16_text_config', JSON.stringify({ fontKey: key, line1: l1, line2: l2, size: s, color: c }));
    applyTextConfig(key, l1, l2, s, c);
}

function applyTextConfig(key, l1, l2, size, color) {
    const style = FONT_STYLES[key] || FONT_STYLES['style1'];
    const t1 = document.getElementById('display-line1');
    const t2 = document.getElementById('display-line2');
    t1.innerText = l1; t2.innerText = l2;
    const container = document.getElementById('title-container');
    container.style.fontFamily = style.font;
    t1.style.letterSpacing = style.spacing; t2.style.letterSpacing = style.spacing;
    t1.style.textShadow = style.shadow; t2.style.textShadow = style.shadow;
    t1.style.textTransform = style.transform; t2.style.textTransform = style.transform;
    t1.style.color = color; t2.style.color = color;
    t1.style.webkitTextFillColor = color; t2.style.webkitTextFillColor = color;
    t1.style.background = 'none'; t2.style.background = 'none';
    if(style.transform.includes('rotate')) { t1.style.transform = style.transform; t2.style.transform = style.transform; }
    else { t1.style.transform = 'none'; t2.style.transform = 'none'; }
    t1.style.fontSize = (0.48 * size) + "px"; t2.style.fontSize = (0.48 * size) + "px";
}

window.toggleMusicPlay = function() {
    if(!bgmAudio.src) return alert("请先在左下角上传音乐");
    if(isMusicPlaying) { bgmAudio.pause(); isMusicPlaying = false; }
    else { bgmAudio.play(); isMusicPlaying = true; }
    updatePlayBtnUI(isMusicPlaying);
}

window.updateVolume = function(val) {
    bgmAudio.volume = val / 100;
    document.getElementById('val-vol').innerText = val;
}

function updatePlayBtnUI(playing) {
    const btn = document.getElementById('play-pause-btn');
    btn.innerText = playing ? "❚❚ 暂停音乐" : "▶ 播放音乐";
}

function initThree() {
    const container = document.getElementById('canvas-container');
    scene = new THREE.Scene();

    // 【修改】加载背景图到 3D 场景中，解决 PostProcessing 遮挡 CSS 背景的问题
    const loader = new THREE.TextureLoader();
    loader.load('./photos/5.jpg', (texture) => {
        bgTexture = texture; // 保存引用以便缩放
        texture.colorSpace = THREE.SRGBColorSpace;
        scene.background = texture;
        resizeBackground(); // 立即计算一次
    });

    camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 2, CONFIG.camera.z);

    renderer = new THREE.WebGLRenderer({ 
        antialias: true, 
        alpha: true, // 允许透明
        powerPreference: "high-performance" 
    });
    
    renderer.setClearColor(0x000000, 0);

    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ReinhardToneMapping;
    renderer.toneMappingExposure = 2.2;
    container.appendChild(renderer.domElement);
    
    mainGroup = new THREE.Group();
    scene.add(mainGroup);

    // 【新增】把下落氛围组加入场景 (独立于 mainGroup)
    scene.add(fallingGroup);
}

function setupEnvironment() {
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
}

function setupLights() {
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const innerLight = new THREE.PointLight(0xffaa00, 2, 20);
    innerLight.position.set(0, 5, 0); mainGroup.add(innerLight);
    const spotGold = new THREE.SpotLight(0xffcc66, 1200);
    spotGold.position.set(30, 40, 40); spotGold.angle = 0.5; spotGold.penumbra = 0.5; scene.add(spotGold);
    const spotBlue = new THREE.SpotLight(0x6688ff, 600);
    spotBlue.position.set(-30, 20, -30); scene.add(spotBlue);
    const fill = new THREE.DirectionalLight(0xffeebb, 0.8);
    fill.position.set(0, 0, 50); scene.add(fill);
}

function setupPostProcessing() {
    const renderScene = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
    bloomPass.threshold = 0.7; bloomPass.strength = 0.45; bloomPass.radius = 0.4;
    composer = new EffectComposer(renderer);
    composer.addPass(renderScene); composer.addPass(bloomPass);
}

// 【新增】背景图等比例适配函数 (模拟 CSS background-size: cover)
function resizeBackground() {
    if (!bgTexture || !bgTexture.image) return;

    const canvasAspect = window.innerWidth / window.innerHeight;
    const imageAspect = bgTexture.image.width / bgTexture.image.height;
    const factor = imageAspect / canvasAspect;

    bgTexture.offset.x = factor > 1 ? (1 - 1 / factor) / 2 : 0;
    bgTexture.repeat.x = factor > 1 ? 1 / factor : 1;

    bgTexture.offset.y = factor > 1 ? 0 : (1 - factor) / 2;
    bgTexture.repeat.y = factor > 1 ? 1 : factor;
}

function createTextures() {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,128,128);
    ctx.fillStyle = '#880000'; ctx.beginPath();
    for(let i=-128; i<256; i+=32) { ctx.moveTo(i, 0); ctx.lineTo(i+32, 128); ctx.lineTo(i+16, 128); ctx.lineTo(i-16, 0); }
    ctx.fill();
    caneTexture = new THREE.CanvasTexture(canvas);
    caneTexture.wrapS = caneTexture.wrapT = THREE.RepeatWrapping; caneTexture.repeat.set(3, 3);
}

class Particle {
    constructor(mesh, type, isDust = false) {
        this.mesh = mesh; this.type = type; this.isDust = isDust;
        this.posTree = new THREE.Vector3(); this.posScatter = new THREE.Vector3();
        this.baseScale = mesh.scale.x;
        this.photoId = null;
        const speedMult = (type === 'PHOTO') ? 0.3 : 2.0;
        this.spinSpeed = new THREE.Vector3((Math.random()-0.5)*speedMult, (Math.random()-0.5)*speedMult, (Math.random()-0.5)*speedMult);
        this.calculatePositions();
    }

    calculatePositions() {
        const h = CONFIG.particles.treeHeight;
        let t = Math.pow(Math.random(), 0.8);
        const y = (t * h) - (h/2);
        let rMax = Math.max(0.5, CONFIG.particles.treeRadius * (1.0 - t));
        const angle = t * 50 * Math.PI + Math.random() * Math.PI;
        const r = rMax * (0.8 + Math.random() * 0.4);
        this.posTree.set(Math.cos(angle) * r, y, Math.sin(angle) * r);

        let rScatter = this.isDust ? (12 + Math.random()*20) : (8 + Math.random()*12);
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        this.posScatter.set(rScatter * Math.sin(phi) * Math.cos(theta), rScatter * Math.sin(phi) * Math.sin(theta), rScatter * Math.cos(phi));
    }

    update(dt, mode, focusTargetMesh) {
        let target = this.posTree;
        if (mode === 'SCATTER') target = this.posScatter;
        else if (mode === 'FOCUS') {
            if (this.mesh === focusTargetMesh) {
                let offset = new THREE.Vector3(0, 1, 38);
                if (STATE.focusType === 1) offset.set(-4, 2, 35);
                else if (STATE.focusType === 2) offset.set(3, 0, 32);
                else if (STATE.focusType === 3) offset.set(0, -2.5, 30);
                const invMatrix = new THREE.Matrix4().copy(mainGroup.matrixWorld).invert();
                target = offset.applyMatrix4(invMatrix);
            } else target = this.posScatter;
        }

        const lerpSpeed = (mode === 'FOCUS' && this.mesh === focusTargetMesh) ? 8.0 : 4.0;
        this.mesh.position.lerp(target, lerpSpeed * dt);

        if (mode === 'SCATTER') {
            this.mesh.rotation.x += this.spinSpeed.x * dt;
            this.mesh.rotation.y += this.spinSpeed.y * dt;
            this.mesh.rotation.z += this.spinSpeed.z * dt;
        } else if (mode === 'TREE') {
            this.mesh.rotation.x = THREE.MathUtils.lerp(this.mesh.rotation.x, 0, dt);
            this.mesh.rotation.z = THREE.MathUtils.lerp(this.mesh.rotation.z, 0, dt);
            this.mesh.rotation.y += 0.5 * dt;
        }

        if (mode === 'FOCUS' && this.mesh === focusTargetMesh) {
            this.mesh.lookAt(camera.position);
            if(STATE.focusType === 1) this.mesh.rotateZ(0.38);
            if(STATE.focusType === 2) this.mesh.rotateZ(-0.15);
            if(STATE.focusType === 3) this.mesh.rotateX(-0.4);
        }

        let s = this.baseScale;
        if (this.isDust) {
            s = this.baseScale * (0.8 + 0.4 * Math.sin(clock.elapsedTime * 4 + this.mesh.id));
            if (mode === 'TREE') s = 0;
        } else if (mode === 'SCATTER' && this.type === 'PHOTO') s = this.baseScale * 2.5;
        else if (mode === 'FOCUS') {
            if (this.mesh === focusTargetMesh) {
                if(STATE.focusType === 2) s = 3.5;
                else if(STATE.focusType === 3) s = 4.8;
                else s = 3.0;
            }
            else s = this.baseScale * 0.8;
        }
        this.mesh.scale.lerp(new THREE.Vector3(s,s,s), 6*dt);
    }
}

function createParticles() {
    const sphereGeo = new THREE.SphereGeometry(0.5, 32, 32);
    const boxGeo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
    const curve = new THREE.CatmullRomCurve3([ new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, 0.3, 0), new THREE.Vector3(0.1, 0.5, 0), new THREE.Vector3(0.3, 0.4, 0) ]);
    const candyGeo = new THREE.TubeGeometry(curve, 16, 0.08, 8, false);

    const goldMat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.champagneGold, metalness: 1.0, roughness: 0.1, envMapIntensity: 2.0, emissive: 0x443300, emissiveIntensity: 0.3 });
    const greenMat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.deepGreen, metalness: 0.2, roughness: 0.8, emissive: 0x002200, emissiveIntensity: 0.2 });
    const redMat = new THREE.MeshPhysicalMaterial({ color: CONFIG.colors.accentRed, metalness: 0.3, roughness: 0.2, clearcoat: 1.0, emissive: 0x330000 });
    const candyMat = new THREE.MeshStandardMaterial({ map: caneTexture, roughness: 0.4 });

    for (let i = 0; i < CONFIG.particles.count; i++) {
        const rand = Math.random();
        let mesh, type;
        if (rand < 0.40) { mesh = new THREE.Mesh(boxGeo, greenMat); type = 'BOX'; }
        else if (rand < 0.70) { mesh = new THREE.Mesh(boxGeo, goldMat); type = 'GOLD_BOX'; }
        else if (rand < 0.92) { mesh = new THREE.Mesh(sphereGeo, goldMat); type = 'GOLD_SPHERE'; }
        else if (rand < 0.97) { mesh = new THREE.Mesh(sphereGeo, redMat); type = 'RED'; }
        else { mesh = new THREE.Mesh(candyGeo, candyMat); type = 'CANE'; }

        const s = 0.4 + Math.random() * 0.5;
        mesh.scale.set(s,s,s); mesh.rotation.set(Math.random()*6, Math.random()*6, Math.random()*6);
        mainGroup.add(mesh); particleSystem.push(new Particle(mesh, type, false));
    }

    const star = new THREE.Mesh(new THREE.OctahedronGeometry(1.2, 0), new THREE.MeshStandardMaterial({ color: 0xffdd88, emissive: 0xffaa00, emissiveIntensity: 1.0, metalness: 1.0, roughness: 0 }));
    star.position.set(0, CONFIG.particles.treeHeight/2 + 1.2, 0); mainGroup.add(star);
    mainGroup.add(photoMeshGroup);
}

function createDust() {
    const geo = new THREE.TetrahedronGeometry(0.08, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffeebb, transparent: true, opacity: 0.8 });
    for(let i=0; i<CONFIG.particles.dustCount; i++) {
            const mesh = new THREE.Mesh(geo, mat); mesh.scale.setScalar(0.5 + Math.random());
            mainGroup.add(mesh); particleSystem.push(new Particle(mesh, 'DUST', true));
    }
}

// 【新增】创建下落的雪花和星光 (添加到 independent 的 fallingGroup)
function createFallingAtmosphere() {
    // 清空旧的（防止重复调用堆积）
    while(fallingGroup.children.length > 0){ 
        fallingGroup.remove(fallingGroup.children[0]); 
    }
    fallingSystem = [];

    const snowGeo = new THREE.TetrahedronGeometry(0.12, 0); 
    const starGeo = new THREE.OctahedronGeometry(0.15, 0); 

    const snowMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.8
    });

    // 星光材质：高发光
    const starMat = new THREE.MeshStandardMaterial({
        color: 0xffffee,
        emissive: 0xffdd88,
        emissiveIntensity: 2.5,
        roughness: 0,
        metalness: 1
    });

    for (let i = 0; i < CONFIG.falling.count; i++) {
        const isStar = Math.random() > 0.7; // 30% 星星
        const mesh = new THREE.Mesh(isStar ? starGeo : snowGeo, isStar ? starMat : snowMat);

        mesh.position.set(
            (Math.random() - 0.5) * CONFIG.falling.rangeX * 1.5, 
            Math.random() * (CONFIG.falling.topY - CONFIG.falling.bottomY) + CONFIG.falling.bottomY,
            (Math.random() - 0.5) * CONFIG.falling.rangeZ
        );

        mesh.userData = {
            velocity: (0.5 + Math.random() * 0.5) * CONFIG.falling.speed,
            wobbleSpeed: Math.random() * 2.0, 
            wobbleAmp: Math.random() * 0.5,   
            offset: Math.random() * 100       
        };

        mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);

        fallingGroup.add(mesh); // 加到独立组，不随树旋转
        fallingSystem.push(mesh);
    }
}

// 【新增】更新下落动画
function updateFallingParticles(dt) {
    fallingSystem.forEach(mesh => {
        const data = mesh.userData;

        // 垂直下落
        mesh.position.y -= data.velocity * dt;

        // 左右摇摆
        mesh.position.x += Math.sin(clock.elapsedTime * data.wobbleSpeed + data.offset) * data.wobbleAmp * dt;

        // 自转
        mesh.rotation.x += dt;
        mesh.rotation.z += dt * 0.5;

        // 循环
        if (mesh.position.y < CONFIG.falling.bottomY) {
            mesh.position.y = CONFIG.falling.topY;
            mesh.position.x = (Math.random() - 0.5) * CONFIG.falling.rangeX * 1.5;
            mesh.position.z = (Math.random() - 0.5) * CONFIG.falling.rangeZ;
        }
    });
}

function createDefaultPhotos() {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#050505'; ctx.fillRect(0,0,512,512);
    ctx.strokeStyle = '#eebb66'; ctx.lineWidth = 15; ctx.strokeRect(20,20,472,472);
    ctx.font = '500 60px Times New Roman'; ctx.fillStyle = '#eebb66'; ctx.textAlign = 'center';
    ctx.fillText("JOYEUX", 256, 230); ctx.fillText("NOEL", 256, 300);
    createPhotoTexture(canvas.toDataURL(), 'default');
}

function createPhotoTexture(base64, id) {
    const img = new Image();
    img.src = base64;
    img.onload = () => {
        const tex = new THREE.Texture(img);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        addPhotoToScene(tex, id, base64);
    }
}

function addPhotoToScene(texture, id, base64) {
    const frameGeo = new THREE.BoxGeometry(1.4, 1.4, 0.05);
    const frameMat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.champagneGold, metalness: 1.0, roughness: 0.1 });
    const frame = new THREE.Mesh(frameGeo, frameMat);
    const photoGeo = new THREE.PlaneGeometry(1.2, 1.2);
    // 开启透明支持，防止png黑边
    const photoMat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide });
    const photo = new THREE.Mesh(photoGeo, photoMat);
    photo.position.z = 0.04;
    const group = new THREE.Group();
    group.add(frame); group.add(photo);
    const s = 0.8; group.scale.set(s,s,s);

    photoMeshGroup.add(group);
    const p = new Particle(group, 'PHOTO', false);
    p.photoId = id;
    p.texture = texture;
    particleSystem.push(p);
}

window.applyParticleSettings = function() {
    const photos = particleSystem.filter(p => p.type === 'PHOTO');
    const toRemove = [];
    mainGroup.children.forEach(c => {
        if(c !== photoMeshGroup) toRemove.push(c);
    });
    toRemove.forEach(c => mainGroup.remove(c));
    particleSystem = [...photos];
    CONFIG.particles.count = parseInt(document.getElementById('slider-tree').value);
    CONFIG.particles.dustCount = parseInt(document.getElementById('slider-dust').value);
    createParticles();
    createDust();
}

async function initMediaPipe() {
    videoElement = document.getElementById('webcam-video');
    const hint = document.getElementById('gesture-hint');
    if (navigator.mediaDevices?.getUserMedia) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true });
            videoElement.srcObject = stream;
            videoElement.onloadedmetadata = () => {
                videoElement.play();
                renderWebcamPreview();
            };
        } catch (e) {
            console.error("Camera denied:", e);
            hint.innerText = "Camera Access Denied";
        }
    }
    try {
        const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm");
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: "./hand_landmarker.task", delegate: "GPU" },
            runningMode: "VIDEO", numHands: 1
        });
        hint.innerText = "手势识别就绪";
        predictWebcam();
    } catch(e) { console.warn("AI Load Failed:", e); hint.innerText = "AI Failed"; }
}

function renderWebcamPreview() {
    const canvas = document.getElementById('webcam-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    function draw() {
        if(videoElement.readyState >= 2) ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
        requestAnimationFrame(draw);
    }
    draw();
}

let lastVideoTime = -1;
async function predictWebcam() {
    if (videoElement && videoElement.currentTime !== lastVideoTime && handLandmarker) {
        lastVideoTime = videoElement.currentTime;
        const result = handLandmarker.detectForVideo(videoElement, performance.now());
        processGestures(result);
        if(result.landmarks.length > 0) document.getElementById('cam-status').classList.add('active');
        else document.getElementById('cam-status').classList.remove('active');
    }
    requestAnimationFrame(predictWebcam);
}

function processGestures(result) {
    const hint = document.getElementById('gesture-hint');
    if (result.landmarks && result.landmarks.length > 0) {
        STATE.hand.detected = true;
        const lm = result.landmarks[0];
        STATE.hand.x = (lm[9].x - 0.5) * 2;
        STATE.hand.y = (lm[9].y - 0.5) * 2;

        const thumb = lm[4]; const index = lm[8]; const wrist = lm[0];
        const pinchDist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
        const tips = [lm[8], lm[12], lm[16], lm[20]];
        let openDist = 0; tips.forEach(t => openDist += Math.hypot(t.x - wrist.x, t.y - wrist.y)); openDist /= 4;

        if (pinchDist < 0.05) {
            hint.innerText = "状态: 抓取 / 聚焦";
            if (STATE.mode !== 'FOCUS') {
                let closestPhoto = null; let minScreenDist = Infinity;

                STATE.focusType = Math.floor(Math.random() * 4);

                particleSystem.filter(p => p.type === 'PHOTO').forEach(p => {
                    p.mesh.updateMatrixWorld();
                    const pos = new THREE.Vector3(); p.mesh.getWorldPosition(pos);
                    const screenPos = pos.project(camera);
                    const dist = Math.hypot(screenPos.x, screenPos.y);
                    if (screenPos.z < 1 && dist < CONFIG.interaction.grabRadius && dist < minScreenDist) {
                        minScreenDist = dist; closestPhoto = p.mesh;
                    }
                });
                if (closestPhoto) { STATE.mode = 'FOCUS'; STATE.focusTarget = closestPhoto; }
            }
        }
        else if (openDist < 0.25) { STATE.mode = 'TREE'; STATE.focusTarget = null; hint.innerText = "状态: 聚合 (圣诞树)"; }
        else if (openDist > 0.4) { STATE.mode = 'SCATTER'; STATE.focusTarget = null; hint.innerText = "状态: 散开 (星云)"; }
    } else {
        STATE.hand.detected = false; hint.innerText = "等待手势...";
    }
}

window.setupEvents = function() {
    window.addEventListener('resize', () => { 
        camera.aspect = window.innerWidth/window.innerHeight; 
        camera.updateProjectionMatrix(); 
        renderer.setSize(window.innerWidth, window.innerHeight); 
        composer.setSize(window.innerWidth, window.innerHeight);
        
        // 【新增】窗口大小改变时，重新计算背景图比例
        resizeBackground();
    });
    
    document.getElementById('file-input').addEventListener('change', (e) => {
        const files = e.target.files;
        if(!files.length) return;
        Array.from(files).forEach(f => {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const base64 = ev.target.result;
                const id = savePhotoToDB(base64);
                createPhotoTexture(base64, id);
            }
            reader.readAsDataURL(f);
        });
    });
    document.getElementById('music-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            saveMusicToDB(file);
            bgmAudio.src = URL.createObjectURL(file);
            bgmAudio.play().then(() => { isMusicPlaying = true; updatePlayBtnUI(true); }).catch(console.error);
        }
    });
    window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'h') window.toggleUI(); });
}

window.openDeleteManager = async function() {
    const modal = document.getElementById('delete-manager');
    const grid = document.getElementById('photo-grid');
    grid.innerHTML = '';
    const photos = await loadPhotosFromDB();
    if(!photos || photos.length === 0) grid.innerHTML = '<div style="color:#888;">暂无照片</div>';
    else {
        photos.forEach((p) => {
            const div = document.createElement('div'); div.className = 'photo-item';
            const img = document.createElement('img'); img.className = 'photo-thumb';
            img.src = p.data;
            const btn = document.createElement('div'); btn.className = 'delete-x'; btn.innerText = 'X';
            btn.onclick = () => confirmDelete(p.id, div);
            div.appendChild(img); div.appendChild(btn); grid.appendChild(div);
        });
    }
    modal.classList.remove('hidden');
}

window.confirmDelete = function(id, divElement) {
    deletePhotoFromDB(id);
    divElement.remove();
    const p = particleSystem.find(part => part.photoId === id);
    if(p) { photoMeshGroup.remove(p.mesh); particleSystem.splice(particleSystem.indexOf(p), 1); }
}

window.clearAllPhotos = function() {
    if(confirm("确定要清空所有照片吗？")) {
        clearPhotosDB();
        particleSystem.filter(p => p.type === 'PHOTO').forEach(p => photoMeshGroup.remove(p.mesh));
        particleSystem = particleSystem.filter(p => p.type !== 'PHOTO');
        window.openDeleteManager();
    }
}

window.closeDeleteManager = function() { document.getElementById('delete-manager').classList.add('hidden'); }

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();

    if (STATE.mode === 'SCATTER' && STATE.hand.detected) {
        const threshold = 0.3;
        const speed = CONFIG.interaction.rotationSpeed; 

        if (STATE.hand.x > threshold) STATE.rotation.y -= speed * dt * (STATE.hand.x - threshold);
        else if (STATE.hand.x < -threshold) STATE.rotation.y -= speed * dt * (STATE.hand.x + threshold);

        if (STATE.hand.y < -threshold) STATE.rotation.x += speed * dt * (-STATE.hand.y - threshold);
        else if (STATE.hand.y > threshold) STATE.rotation.x -= speed * dt * (STATE.hand.y - threshold);
    } else {
        if(STATE.mode === 'TREE') {
            STATE.rotation.y += 0.3 * dt;
            STATE.rotation.x += (0 - STATE.rotation.x) * 2.0 * dt;
        } else {
                STATE.rotation.y += 0.1 * dt;
        }
    }

    mainGroup.rotation.y = STATE.rotation.y;
    mainGroup.rotation.x = STATE.rotation.x;

    particleSystem.forEach(p => p.update(dt, STATE.mode, STATE.focusTarget));
    
    // 【新增】更新下落雪花动画
    updateFallingParticles(dt);

    composer.render();
}

init();