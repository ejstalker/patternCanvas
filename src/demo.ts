import { initWebGPU, loadShaderModule } from './utils/webgpu';
import vertexShaderCode from './shaders/cloth.vert.wgsl?raw';
import fragmentShaderCode from './shaders/cloth.frag.wgsl?raw';
import { Renderer } from './Renderer';
import { Cloth } from './Cloth';
import { SimpleCloth } from './SimpleCloth';
import { Ground } from './Ground';
import { SphericalGround } from './SphericalGround';
import { Camera } from './Camera';
import { vec3 } from 'gl-matrix';

// Mode state
type ClothMode = 'physics' | 'simple';

// Scene class to hold state for each scene
class Scene {
    cloth: Cloth | SimpleCloth;
    camera: Camera;
    mode: ClothMode;
    
    constructor(cloth: Cloth | SimpleCloth, camera: Camera, mode: ClothMode) {
        this.cloth = cloth;
        this.camera = camera;
        this.mode = mode;
    }
    
    destroy(): void {
        this.cloth.destroy();
    }
}

// Global state
let device: GPUDevice;
let renderer: Renderer;
let canvas: HTMLCanvasElement;
let isRunning: boolean = false;
let leftMouseDown: boolean = false;
let rightMouseDown: boolean = false;
let mouseX: number = 0;
let mouseY: number = 0;

// Helpers to pull current UI values (with safe fallbacks)
function getGravityInputValue(): number {
    const gravityInput = document.getElementById('gravity') as HTMLInputElement | null;
    if (gravityInput) {
        const val = parseFloat(gravityInput.value);
        if (!Number.isNaN(val) && Number.isFinite(val)) return val;
    }
    return 0.8;
}

function getMassInputValue(): number {
    const massInput = document.getElementById('mass') as HTMLInputElement | null;
    if (massInput) {
        const val = parseFloat(massInput.value);
        if (!Number.isNaN(val) && Number.isFinite(val)) return val;
    }
    return 100.0;
}

function getSpringConstInputValue(): number {
    const springInput = document.getElementById('springConst') as HTMLInputElement | null;
    if (springInput) {
        const val = parseFloat(springInput.value);
        if (!Number.isNaN(val) && Number.isFinite(val)) return val;
    }
    return 1000.0;
}

function getDampingConstInputValue(): number {
    const dampingInput = document.getElementById('dampingConst') as HTMLInputElement | null;
    if (dampingInput) {
        const val = parseFloat(dampingInput.value);
        if (!Number.isNaN(val) && Number.isFinite(val)) return val;
    }
    return 3.5;
}

function getFluidDensityInputValue(): number {
    const fluidInput = document.getElementById('fluidDensity') as HTMLInputElement | null;
    if (fluidInput) {
        const val = parseFloat(fluidInput.value);
        if (!Number.isNaN(val) && Number.isFinite(val)) return val;
    }
    return 1.225;
}

function getWindVelocityInputValue(): vec3 {
    const wx = document.getElementById('windX') as HTMLInputElement | null;
    const wy = document.getElementById('windY') as HTMLInputElement | null;
    const wz = document.getElementById('windZ') as HTMLInputElement | null;
    const vx = wx ? parseFloat(wx.value) : 0.5;
    const vy = wy ? parseFloat(wy.value) : 0.5;
    const vz = wz ? parseFloat(wz.value) : -2.5;
    return [
        Number.isFinite(vx) ? vx : 0.5,
        Number.isFinite(vy) ? vy : 0.5,
        Number.isFinite(vz) ? vz : -2.5,
    ];
}

// Scene management
let scenes: Scene[] = [];
let currentSceneIndex: number = 0;

// Helper to get current scene
function getCurrentScene(): Scene {
    return scenes[currentSceneIndex];
}

// UI callbacks
let translateFixedFn: ((axis: number, shift: number) => void) | null = null;
let rotateFixedFn: ((axis: number, shift: number) => void) | null = null;
let resetCameraFn: (() => void) | null = null;

function createCloth(numParticles: number): Cloth {
    const ground = new Ground([-5.0, 0.0, -5.0], 10.0, device);
    return new Cloth(
        4.0, // size
        100.0, // mass
        numParticles, // N particles
        [-2.0, 3.8, 0.0], // top left position
        [1.0, 0.0, 0.0], // horizontal direction
        [0.0, -1.0, 0.0], // vertical direction
        device,
        ground
    );
}

function createSimpleCloth(numTriangles: number): SimpleCloth {
    const ground = new Ground([-5.0, 0.0, -5.0], 10.0, device);
    return new SimpleCloth(
        4.0, // size
        numTriangles, // target number of triangles
        [-2.0, 3.8, 0.0], // top left position
        [1.0, 0.0, 0.0], // horizontal direction
        [0.0, -1.0, 0.0], // vertical direction
        device,
        ground
    );
}

function createClothWithSphere(numParticles: number): Cloth {
    // Create a sphere at the origin with radius 2.0 (top at y=2.0, bottom at y=-2.0)
    const sphereGround = new SphericalGround([0.0, 0.0, 0.0], 2.0, device);
    return new Cloth(
        4.0, // size
        100.0, // mass
        numParticles, // N particles
        [-2.0, 4.0, 2.0], // top left position - cloth is horizontal, centered above sphere at Y=4.0, Z goes from 2.0 to -2.0
        [1.0, 0.0, 0.0], // horizontal direction (moves in +X)
        [0.0, 0.0, -1.0], // vertical direction (moves in -Z, making cloth horizontal/parallel to sphere)
        device,
        sphereGround
    );
}

function createSimpleClothWithSphere(numTriangles: number): SimpleCloth {
    // Create a sphere shifted to the left with radius 2.0 (top at y=2.0, bottom at y=-2.0)
    const sphereGround = new SphericalGround([0.0, 0.0, 0.0], 2.0, device);
    return new SimpleCloth(
        4.0, // size
        numTriangles, // target number of triangles
        [-2.0, 4.0, 2.0], // top left position - cloth is horizontal, centered above sphere at Y=4.0, Z goes from 2.0 to -2.0, shifted left
        [1.0, 0.0, 0.0], // horizontal direction (moves in +X)
        [0.0, 0.0, -1.0], // vertical direction (moves in -Z, making cloth horizontal/parallel to sphere)
        device,
        sphereGround
    );
}

function recreateCloth(numParticles: number): void {
    const scene = getCurrentScene();
    const currentGround = scene.cloth ? scene.cloth.getGround() : null;
    const useSphere = currentGround instanceof SphericalGround;
    
    if (scene.cloth) {
        scene.cloth.destroy();
    }
    
    if (useSphere) {
        scene.cloth = createClothWithSphere(numParticles);
        // Apply current UI settings for Scene 2
        scene.cloth.setGravityAcce(getGravityInputValue());
        scene.cloth.setFluidDensity(getFluidDensityInputValue());
        scene.cloth.setWindVelocity(getWindVelocityInputValue());
        scene.cloth.setDampingConst(getDampingConstInputValue());
        scene.cloth.setSpringConst(getSpringConstInputValue());
        scene.cloth.setMass(getMassInputValue());
        // Cloth does not start dropped - user clicks "Drop!" button
    } else {
        scene.cloth = createCloth(numParticles);
        scene.cloth.enablePhysics(); // Scene 1 starts with physics running, but top row stays fixed
        scene.cloth.setGravityAcce(getGravityInputValue());
        scene.cloth.setFluidDensity(getFluidDensityInputValue());
        scene.cloth.setWindVelocity(getWindVelocityInputValue());
        scene.cloth.setDampingConst(getDampingConstInputValue());
        scene.cloth.setSpringConst(getSpringConstInputValue());
        scene.cloth.setMass(getMassInputValue());
    }
    // Update triangle count display
    const triangleCount = 2 * (numParticles - 1) * (numParticles - 1);
    if (window.updateTriangleCount) {
        window.updateTriangleCount(triangleCount);
    }
}

function recreateSimpleCloth(numTriangles: number): void {
    const scene = getCurrentScene();
    const currentGround = scene.cloth ? scene.cloth.getGround() : null;
    const useSphere = currentGround instanceof SphericalGround;
    
    if (scene.cloth instanceof SimpleCloth) {
        // Use setNumTriangles if it's already a SimpleCloth (more efficient)
        scene.cloth.setNumTriangles(numTriangles);
        const actualTriangleCount = scene.cloth.getNumTriangles();
        if (window.updateTriangleCount) {
            window.updateTriangleCount(actualTriangleCount);
        }
        
        // Reset to initial state for Scene 2 (spherical ground)
        // This ensures cloth goes back to top initial state (parallel to sphere) when triangle count changes
        if (useSphere) {
            scene.cloth.resetToInitialState();
            // Apply gentle gravity settings for Scene 2
            scene.cloth.setGravityAcce(getGravityInputValue());
            scene.cloth.setFluidDensity(3.0);
            scene.cloth.setWindVelocity([0.0, 0.0, 0.0]);
            scene.cloth.setDampingConst(15.0);
            scene.cloth.setSpringConst(100.0); // Lower default for simple mode to avoid stretching
        } else {
            // Scene 1: enable physics with top row fixed
            scene.cloth.enablePhysics();
        }
    } else {
        // Need to recreate if it's a different type
        if (scene.cloth) {
            scene.cloth.destroy();
        }
        if (useSphere) {
            scene.cloth = createSimpleClothWithSphere(numTriangles);
            // Apply current UI settings for Scene 2 simple mode
            scene.cloth.setGravityAcce(getGravityInputValue());
            scene.cloth.setFluidDensity(getFluidDensityInputValue());
            scene.cloth.setWindVelocity(getWindVelocityInputValue());
            scene.cloth.setDampingConst(getDampingConstInputValue());
            scene.cloth.setSpringConst(getSpringConstInputValue());
            scene.cloth.setMass(getMassInputValue());
            // Cloth does not start dropped - user clicks "Drop!" button
        } else {
            scene.cloth = createSimpleCloth(numTriangles);
            scene.cloth.enablePhysics(); // Scene 1 starts with physics running, but top row stays fixed
            scene.cloth.setGravityAcce(getGravityInputValue());
            scene.cloth.setFluidDensity(getFluidDensityInputValue());
            scene.cloth.setWindVelocity(getWindVelocityInputValue());
            scene.cloth.setDampingConst(getDampingConstInputValue());
            scene.cloth.setSpringConst(getSpringConstInputValue());
            scene.cloth.setMass(getMassInputValue());
        }
        if (scene.cloth instanceof SimpleCloth) {
            const actualTriangleCount = scene.cloth.getNumTriangles();
            if (window.updateTriangleCount) {
                window.updateTriangleCount(actualTriangleCount);
            }
        }
    }
}

function switchMode(mode: ClothMode): void {
    const scene = getCurrentScene();
    if (scene.mode === mode) return;
    
    scene.mode = mode;
    
    if (scene.cloth) {
        scene.cloth.destroy();
    }
    
    // Check if current scene uses spherical ground
    const currentGround = scene.cloth ? scene.cloth.getGround() : null;
    const useSphere = currentGround instanceof SphericalGround;
    
    if (mode === 'physics') {
        if (useSphere) {
            scene.cloth = createClothWithSphere(25);
            // Apply gentle gravity settings for Scene 2
            scene.cloth.setGravityAcce(getGravityInputValue());
            scene.cloth.setFluidDensity(3.0);
            scene.cloth.setWindVelocity([0.0, 0.0, 0.0]);
            scene.cloth.setDampingConst(15.0);
            // Cloth does not start dropped - user clicks "Drop!" button
        } else {
            scene.cloth = createCloth(25);
            scene.cloth.enablePhysics(); // Scene 1 starts with physics running, but top row stays fixed
        }
        const triangleCount = 2 * (25 - 1) * (25 - 1);
        if (window.updateTriangleCount) {
            window.updateTriangleCount(triangleCount);
        }
        // Update UI input value
        const numParticlesInput = document.getElementById('numParticles') as HTMLInputElement;
        if (numParticlesInput) numParticlesInput.value = '25';
        // Disable wireframe mode when switching to physics
        if (renderer) {
            renderer.setWireframeMode(false);
        }
        const wireframeToggle = document.getElementById('wireframeToggle') as HTMLInputElement;
        if (wireframeToggle) wireframeToggle.checked = false;
    } else {
        if (useSphere) {
            scene.cloth = createSimpleClothWithSphere(1000);
            // Apply current UI settings for Scene 2 simple mode
            scene.cloth.setGravityAcce(getGravityInputValue());
            scene.cloth.setFluidDensity(getFluidDensityInputValue());
            scene.cloth.setWindVelocity(getWindVelocityInputValue());
            scene.cloth.setDampingConst(getDampingConstInputValue());
            scene.cloth.setSpringConst(getSpringConstInputValue());
            scene.cloth.setMass(getMassInputValue());
            // Cloth does not start dropped - user clicks "Drop!" button
        } else {
            scene.cloth = createSimpleCloth(1000);
            scene.cloth.enablePhysics(); // Scene 1 starts with physics running, but top row stays fixed
            scene.cloth.setGravityAcce(getGravityInputValue());
            scene.cloth.setFluidDensity(getFluidDensityInputValue());
            scene.cloth.setWindVelocity(getWindVelocityInputValue());
            scene.cloth.setDampingConst(getDampingConstInputValue());
            scene.cloth.setSpringConst(getSpringConstInputValue());
            scene.cloth.setMass(getMassInputValue());
        }
        if (scene.cloth instanceof SimpleCloth) {
            const actualTriangleCount = scene.cloth.getNumTriangles();
            if (window.updateTriangleCount) {
                window.updateTriangleCount(actualTriangleCount);
            }
        }
        // Enable wireframe mode by default when switching to simple mode
        if (renderer) {
            renderer.setWireframeMode(true);
        }
        const wireframeToggle = document.getElementById('wireframeToggle') as HTMLInputElement;
        if (wireframeToggle) wireframeToggle.checked = true;
    }
    
    // Update UI visibility
    updateUIVisibility();
}

function updateUIVisibility(): void {
    const scene = getCurrentScene();
    const physicsControls = document.getElementById('cloth-coeffs');
    const springDamperControls = document.getElementById('spring-damper');
    const aerodynamicsControls = document.getElementById('aerodynamics');
    const simpleControls = document.getElementById('simple-cloth-controls');
    const numParticlesInput = document.getElementById('numParticles')?.parentElement;
    
    if (scene.mode === 'physics') {
        if (physicsControls) physicsControls.style.display = 'block';
        if (numParticlesInput) numParticlesInput.style.display = 'block';
        if (springDamperControls) springDamperControls.style.display = 'block';
        if (aerodynamicsControls) aerodynamicsControls.style.display = 'block';
        if (simpleControls) simpleControls.style.display = 'none';
    } else {
        // Simple mode - hide particle count but show other physics controls
        if (physicsControls) physicsControls.style.display = 'block';
        if (numParticlesInput) numParticlesInput.style.display = 'none';
        if (springDamperControls) springDamperControls.style.display = 'block';
        if (aerodynamicsControls) aerodynamicsControls.style.display = 'block';
        if (simpleControls) simpleControls.style.display = 'block';
    }
}

function switchScene(sceneIndex: number): void {
    if (sceneIndex < 0 || sceneIndex >= scenes.length) {
        console.error(`Invalid scene index: ${sceneIndex}`);
        return;
    }
    
    if (currentSceneIndex === sceneIndex) return;
    
    currentSceneIndex = sceneIndex;
    const scene = getCurrentScene();
    
    // For Scene 2 (spherical ground, now at index 0), recreate the cloth fresh each time
    // This ensures a clean state without accumulated physics artifacts
    if (sceneIndex === 0) {
        // Destroy old cloth
        scene.cloth.destroy();
        // Create new cloth with sphere
        scene.cloth = createClothWithSphere(25);
        // Apply current UI settings for Scene 2
        scene.cloth.setGravityAcce(getGravityInputValue());
        scene.cloth.setFluidDensity(getFluidDensityInputValue());
        scene.cloth.setWindVelocity(getWindVelocityInputValue());
        scene.cloth.setDampingConst(getDampingConstInputValue());
        scene.cloth.setSpringConst(getSpringConstInputValue());
        scene.cloth.setMass(getMassInputValue());
        // Cloth does not start dropped - user clicks "Drop!" button
    } else {
        // For Scene 1 (now at index 1), just reset timing
        if (scene.cloth instanceof Cloth) {
            scene.cloth.resetTiming();
        } else if (scene.cloth instanceof SimpleCloth) {
            scene.cloth.resetTiming();
        }
    }
    
    // Update UI to reflect current scene's state
    updateUIVisibility();
    
    // Update mode radio buttons
    const modePhysics = document.getElementById('modePhysics') as HTMLInputElement;
    const modeSimple = document.getElementById('modeSimple') as HTMLInputElement;
    if (modePhysics && modeSimple) {
        modePhysics.checked = scene.mode === 'physics';
        modeSimple.checked = scene.mode === 'simple';
    }
    
    // Show/hide Scene 2 specific controls (Before Drop / Drop!)
    const scene2Controls = document.getElementById('scene2Controls');
    if (scene2Controls) {
        scene2Controls.style.display = sceneIndex === 0 ? 'block' : 'none';
    }
    
    // Update camera aspect ratio
    scene.camera.setAspect(canvas.width / canvas.height);
    scene.camera.update();
    
    // Update triangle count display
    if (scene.cloth instanceof Cloth) {
        const triangleCount = scene.cloth.getIndexCount() / 3;
        if (window.updateTriangleCount) {
            window.updateTriangleCount(triangleCount);
        }
    } else if (scene.cloth instanceof SimpleCloth) {
        const actualTriangleCount = scene.cloth.getNumTriangles();
        if (window.updateTriangleCount) {
            window.updateTriangleCount(actualTriangleCount);
        }
    }
}

async function init(): Promise<void> {
    canvas = document.getElementById('canvas') as HTMLCanvasElement;
    if (!canvas) {
        throw new Error('Canvas not found');
    }

    // Set canvas size
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Initialize WebGPU
    const webgpu = await initWebGPU(canvas);
    device = webgpu.device;

    // Shaders are imported at the top of the file

    // Create renderer
    renderer = new Renderer(
        device,
        webgpu.context,
        webgpu.format,
        webgpu.depthTexture,
        webgpu.depthTextureView,
        canvas
    );
    await renderer.initialize(vertexShaderCode, fragmentShaderCode);

    // Create Scene 2 (with spherical ground) - now first
    const camera2 = new Camera();
    camera2.setAspect(canvas.width / canvas.height);
    camera2.setDistance(15.00);
    camera2.setAzimuth(-331.00);
    camera2.setIncline(35.00);
    camera2.setPanX(-1.60);
    camera2.setPanY(-0.20);
    camera2.setPanZ(0.00);
    camera2.update();
    const cloth2 = createClothWithSphere(25);
    // Apply current UI settings for Scene 2
    cloth2.setGravityAcce(getGravityInputValue());
    cloth2.setFluidDensity(getFluidDensityInputValue());
    cloth2.setWindVelocity(getWindVelocityInputValue());
    cloth2.setDampingConst(getDampingConstInputValue());
    cloth2.setSpringConst(getSpringConstInputValue());
    cloth2.setMass(getMassInputValue());
    // Cloth does not start dropped - user clicks "Drop!" button
    scenes.push(new Scene(cloth2, camera2, 'physics'));
    
    // Create Scene 1 - now second
    const camera1 = new Camera();
    camera1.setAspect(canvas.width / canvas.height);
    camera1.setDistance(11.00);
    camera1.setAzimuth(56.00);
    camera1.setIncline(17.00);
    camera1.setPanX(-0.80);
    camera1.setPanY(-0.60);
    camera1.setPanZ(0.00);
    camera1.update();
    const cloth1 = createCloth(25);
    cloth1.enablePhysics(); // Scene 1 starts with physics running, but top row stays fixed
    scenes.push(new Scene(cloth1, camera1, 'physics'));
    
    // Initialize triangle count display
    const triangleCount = 2 * (25 - 1) * (25 - 1);
    if (window.updateTriangleCount) {
        window.updateTriangleCount(triangleCount);
    }

    // Setup UI callbacks
    setupUICallbacks();
    setupUIControls();

    // Setup event listeners
    setupEventListeners();

    // Ensure buffers are ready before starting render loop
    // Wait one frame to ensure all WebGPU operations are complete
    await new Promise(resolve => requestAnimationFrame(resolve));

    // Start render loop
    isRunning = true;
    requestAnimationFrame(renderLoop);
}

function setupUICallbacks(): void {
    translateFixedFn = (axis: number, shift: number) => {
        const scene = getCurrentScene();
        if (scene.cloth instanceof Cloth) {
            scene.cloth.translateFixedParticles(axis, shift);
        } else if (scene.cloth instanceof SimpleCloth) {
            scene.cloth.translateFixedParticles(axis, shift);
        }
    };

    rotateFixedFn = (axis: number, shift: number) => {
        const scene = getCurrentScene();
        if (scene.cloth instanceof Cloth) {
            scene.cloth.rotateFixedParticles(axis, shift);
        } else if (scene.cloth instanceof SimpleCloth) {
            scene.cloth.rotateFixedParticles(axis, shift);
        }
    };

    resetCameraFn = () => {
        const scene = getCurrentScene();
        const sceneIndex = currentSceneIndex;
        
        // Reset to scene-specific initial values
        if (sceneIndex === 0) {
            // Scene 2 initial values (now at index 0)
            scene.camera.setDistance(15.00);
            scene.camera.setAzimuth(-331.00);
            scene.camera.setIncline(35.00);
            scene.camera.setPanX(-1.60);
            scene.camera.setPanY(-0.20);
            scene.camera.setPanZ(0.00);
        } else if (sceneIndex === 1) {
            // Scene 1 initial values (now at index 1)
            scene.camera.setDistance(11.00);
            scene.camera.setAzimuth(56.00);
            scene.camera.setIncline(17.00);
            scene.camera.setPanX(-0.80);
            scene.camera.setPanY(-0.60);
            scene.camera.setPanZ(0.00);
        }
        
        scene.camera.setAspect(canvas.width / canvas.height);
        scene.camera.update();
    };

    if (window.setupUICallbacks) {
        window.setupUICallbacks({
            translateFixed: translateFixedFn,
            rotateFixed: rotateFixedFn,
            resetCamera: resetCameraFn,
        });
    }
}

function updateLighting(): void {
    const light1R = parseFloat((document.getElementById('light1R') as HTMLInputElement)?.value || '0.5');
    const light1G = parseFloat((document.getElementById('light1G') as HTMLInputElement)?.value || '0.5');
    const light1B = parseFloat((document.getElementById('light1B') as HTMLInputElement)?.value || '0.0');
    const light1X = parseFloat((document.getElementById('light1X') as HTMLInputElement)?.value || '1');
    const light1Y = parseFloat((document.getElementById('light1Y') as HTMLInputElement)?.value || '5');
    const light1Z = parseFloat((document.getElementById('light1Z') as HTMLInputElement)?.value || '2');
    
    const light2R = parseFloat((document.getElementById('light2R') as HTMLInputElement)?.value || '0.5');
    const light2G = parseFloat((document.getElementById('light2G') as HTMLInputElement)?.value || '0.0');
    const light2B = parseFloat((document.getElementById('light2B') as HTMLInputElement)?.value || '0.0');
    const light2X = parseFloat((document.getElementById('light2X') as HTMLInputElement)?.value || '-1');
    const light2Y = parseFloat((document.getElementById('light2Y') as HTMLInputElement)?.value || '-5');
    const light2Z = parseFloat((document.getElementById('light2Z') as HTMLInputElement)?.value || '-2');
    
    renderer.setLight1Color(light1R, light1G, light1B);
    renderer.setLight1Position(light1X, light1Y, light1Z);
    renderer.setLight2Color(light2R, light2G, light2B);
    renderer.setLight2Position(light2X, light2Y, light2Z);
}

function toggleWireframe(): void {
    const wireframeToggle = document.getElementById('wireframeToggle') as HTMLInputElement;
    if (wireframeToggle && renderer) {
        renderer.setWireframeMode(wireframeToggle.checked);
    }
}

// Export to window
if (typeof window !== 'undefined') {
    (window as any).toggleWireframe = toggleWireframe;
}

function updateColors(): void {
    const clothR = parseFloat((document.getElementById('clothR') as HTMLInputElement)?.value || '0.9');
    const clothG = parseFloat((document.getElementById('clothG') as HTMLInputElement)?.value || '0.01');
    const clothB = parseFloat((document.getElementById('clothB') as HTMLInputElement)?.value || '0.01');
    
    const groundR = parseFloat((document.getElementById('groundR') as HTMLInputElement)?.value || '0.3');
    const groundG = parseFloat((document.getElementById('groundG') as HTMLInputElement)?.value || '0.3');
    const groundB = parseFloat((document.getElementById('groundB') as HTMLInputElement)?.value || '0.35');
    
    renderer.setClothColor(clothR, clothG, clothB);
    renderer.setGroundColor(groundR, groundG, groundB);
}

function setupUIControls(): void {
    // Setup wireframe toggle
    const wireframeToggle = document.getElementById('wireframeToggle') as HTMLInputElement;
    if (wireframeToggle) {
        wireframeToggle.addEventListener('change', () => {
            if (renderer) {
                renderer.setWireframeMode(wireframeToggle.checked);
            }
        });
    }
    
    if (window.setupUIControls) {
        window.setupUIControls(
            (id: string, value: number) => {
                const scene = getCurrentScene();
                switch (id) {
                    case 'numParticles':
                        if (scene.mode === 'physics') {
                            const numParticles = Math.max(5, Math.min(39, Math.round(value)));
                            recreateCloth(numParticles);
                        }
                        break;
                    case 'numTriangles':
                        if (scene.mode === 'simple') {
                            const numTriangles = Math.max(2, Math.min(10000, Math.round(value)));
                            recreateSimpleCloth(numTriangles);
                        }
                        break;
                    case 'mass':
                        if (scene.cloth instanceof Cloth) {
                            scene.cloth.setMass(value);
                        } else if (scene.cloth instanceof SimpleCloth) {
                            scene.cloth.setMass(value);
                        }
                        break;
                    case 'gravity':
                        if (scene.cloth instanceof Cloth) {
                            scene.cloth.setGravityAcce(value);
                        } else if (scene.cloth instanceof SimpleCloth) {
                            scene.cloth.setGravityAcce(value);
                        }
                        break;
                    case 'ground':
                        if (scene.cloth instanceof Cloth) {
                            scene.cloth.setGroundPos(value);
                        } else if (scene.cloth instanceof SimpleCloth) {
                            scene.cloth.setGroundPos(value);
                        }
                        break;
                    case 'springConst':
                        if (scene.cloth instanceof Cloth) {
                            scene.cloth.setSpringConst(value);
                        } else if (scene.cloth instanceof SimpleCloth) {
                            scene.cloth.setSpringConst(value);
                        }
                        break;
                    case 'dampingConst':
                        if (scene.cloth instanceof Cloth) {
                            scene.cloth.setDampingConst(value);
                        } else if (scene.cloth instanceof SimpleCloth) {
                            scene.cloth.setDampingConst(value);
                        }
                        break;
                    case 'windX':
                    case 'windY':
                    case 'windZ': {
                        if (scene.cloth instanceof Cloth) {
                            const wind = scene.cloth.getWindVelocity();
                            if (id === 'windX') wind[0] = value;
                            else if (id === 'windY') wind[1] = value;
                            else if (id === 'windZ') wind[2] = value;
                            scene.cloth.setWindVelocity(wind);
                        } else if (scene.cloth instanceof SimpleCloth) {
                            const wind = scene.cloth.getWindVelocity();
                            if (id === 'windX') wind[0] = value;
                            else if (id === 'windY') wind[1] = value;
                            else if (id === 'windZ') wind[2] = value;
                            scene.cloth.setWindVelocity(wind);
                        }
                        break;
                    }
                    case 'fluidDensity':
                        if (scene.cloth instanceof Cloth) {
                            scene.cloth.setFluidDensity(value);
                        } else if (scene.cloth instanceof SimpleCloth) {
                            scene.cloth.setFluidDensity(value);
                        }
                        break;
                    case 'dragConst':
                        if (scene.cloth instanceof Cloth) {
                            scene.cloth.setDragConst(value);
                        } else if (scene.cloth instanceof SimpleCloth) {
                            scene.cloth.setDragConst(value);
                        }
                        break;
                }
            },
            updateLighting,
            updateColors,
            switchMode
        );
    }
    
    // Initialize lighting and colors from UI defaults
    updateLighting();
    updateColors();
    updateUIVisibility();
}

function setupEventListeners(): void {
    // Keyboard
    window.addEventListener('keydown', (e) => {
        // Prevent default for spacebar in Scene 2 to avoid page scrolling
        if (e.key === ' ' && currentSceneIndex === 0) {
            e.preventDefault();
        }
        
        switch (e.key) {
            case 'Escape':
                isRunning = false;
                break;
            case 'r':
            case 'R':
                resetCameraFn?.();
                break;
            case 'z':
            case 'Z': {
                const scene = getCurrentScene();
                scene.camera.setDistance(Math.max(scene.camera.getDistance() - 1.0, 1.0));
                scene.camera.update();
                break;
            }
            case 'x':
            case 'X': {
                const scene = getCurrentScene();
                scene.camera.setDistance(scene.camera.getDistance() + 1.0);
                scene.camera.update();
                break;
            }
            case 'l':
            case 'L': {
                // Log current camera data for finding perfect initial position
                const scene = getCurrentScene();
                const sceneIndex = currentSceneIndex;
                console.log(`=== Camera Data for Scene ${sceneIndex + 1} ===`);
                console.log(`Distance: ${scene.camera.getDistance().toFixed(2)}`);
                console.log(`Azimuth: ${scene.camera.getAzimuth().toFixed(2)}`);
                console.log(`Incline: ${scene.camera.getIncline().toFixed(2)}`);
                console.log(`Pan X: ${scene.camera.getPanX().toFixed(2)}`);
                console.log(`Pan Y: ${scene.camera.getPanY().toFixed(2)}`);
                console.log(`Pan Z: ${scene.camera.getPanZ().toFixed(2)}`);
                console.log(`Code: camera${sceneIndex + 1}.setDistance(${scene.camera.getDistance().toFixed(2)});`);
                console.log(`      camera${sceneIndex + 1}.setAzimuth(${scene.camera.getAzimuth().toFixed(2)});`);
                console.log(`      camera${sceneIndex + 1}.setIncline(${scene.camera.getIncline().toFixed(2)});`);
                console.log(`      camera${sceneIndex + 1}.setPanX(${scene.camera.getPanX().toFixed(2)});`);
                console.log(`      camera${sceneIndex + 1}.setPanY(${scene.camera.getPanY().toFixed(2)});`);
                console.log(`      camera${sceneIndex + 1}.setPanZ(${scene.camera.getPanZ().toFixed(2)});`);
                console.log('=====================================');
                break;
            }
            case 'w':
            case 'W': {
                // Pan down (reversed)
                const scene = getCurrentScene();
                scene.camera.addPan(0.0, -0.2, 0.0);
                scene.camera.update();
                break;
            }
            case 's':
            case 'S': {
                // Pan up (reversed)
                const scene = getCurrentScene();
                scene.camera.addPan(0.0, 0.2, 0.0);
                scene.camera.update();
                break;
            }
            case 'a':
            case 'A': {
                // Pan left (reversed)
                const scene = getCurrentScene();
                scene.camera.addPan(0.2, 0.0, 0.0);
                scene.camera.update();
                break;
            }
            case 'd':
            case 'D': {
                // Pan right (reversed)
                const scene = getCurrentScene();
                scene.camera.addPan(-0.2, 0.0, 0.0);
                scene.camera.update();
                break;
            }
            case ' ': {
                // Spacebar: Toggle drop/reset for Scene 2
                if (currentSceneIndex === 0) { // Scene 2 (now at index 0)
                    const scene = getCurrentScene();
                    if (scene.cloth instanceof Cloth) {
                        if (scene.cloth.isClothDropped()) {
                            scene.cloth.resetToInitialState();
                        } else {
                            scene.cloth.drop();
                        }
                    } else if (scene.cloth instanceof SimpleCloth) {
                        if (scene.cloth.isClothDropped()) {
                            scene.cloth.resetToInitialState();
                        } else {
                            scene.cloth.drop();
                        }
                    }
                }
                break;
            }
        }
    });

    // Mouse
    canvas.addEventListener('mousedown', (e) => {
        if (e.button === 0) leftMouseDown = true;
        if (e.button === 2) rightMouseDown = true;
    });

    canvas.addEventListener('mouseup', (e) => {
        if (e.button === 0) leftMouseDown = false;
        if (e.button === 2) rightMouseDown = false;
    });

    canvas.addEventListener('mousemove', (e) => {
        const maxDelta = 100;
        const dx = Math.max(-maxDelta, Math.min(maxDelta, e.clientX - mouseX));
        const dy = Math.max(-maxDelta, Math.min(maxDelta, -(e.clientY - mouseY)));

        mouseX = e.clientX;
        mouseY = e.clientY;

        if (leftMouseDown) {
            const scene = getCurrentScene();
            const rate = 1.0;
            scene.camera.setAzimuth(scene.camera.getAzimuth() + dx * rate);
            scene.camera.setIncline(Math.max(-90, Math.min(90, scene.camera.getIncline() - dy * rate)));
            scene.camera.update();
        }

        if (rightMouseDown) {
            const scene = getCurrentScene();
            const rate = 0.005;
            const dist = Math.max(0.01, Math.min(1000, scene.camera.getDistance() * (1.0 - dx * rate)));
            scene.camera.setDistance(dist);
            scene.camera.update();
        }
    });

    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });

    // Resize
    window.addEventListener('resize', () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        // Update all scene cameras
        scenes.forEach(scene => {
            scene.camera.setAspect(canvas.width / canvas.height);
            scene.camera.update();
        });
        renderer.resize(canvas.width, canvas.height);
    });
}

function renderLoop(): void {
    if (!isRunning) return;

    try {
        const scene = getCurrentScene();
        
        // Check if buffers are initialized
        if (!scene.cloth.getPositionBuffer() || !scene.cloth.getNormalBuffer() || !scene.cloth.getIndexBuffer()) {
            console.warn('Buffers not ready, skipping frame');
            requestAnimationFrame(renderLoop);
            return;
        }

        // Update (both modes have physics now)
        scene.cloth.update();
        
        // Update FPS
        if (window.updateFPS) {
            if (scene.cloth instanceof Cloth) {
                window.updateFPS(scene.cloth.getFPS());
            } else if (scene.cloth instanceof SimpleCloth) {
                window.updateFPS(scene.cloth.getFPS());
            }
        }

        // Render
        renderer.render(scene.cloth, scene.camera);
    } catch (error) {
        console.error('Error in render loop:', error);
        // Continue render loop even if there's an error
    }

    requestAnimationFrame(renderLoop);
}

// Export functions to window for UI
if (typeof window !== 'undefined') {
    (window as any).switchScene = (sceneIndex: number) => {
        // Convert from 1-based (UI) to 0-based (array)
        switchScene(sceneIndex - 1);
    };
    
    (window as any).resetClothToInitial = () => {
        const scene = getCurrentScene();
        if (scene.cloth instanceof Cloth) {
            scene.cloth.resetToInitialState();
        } else if (scene.cloth instanceof SimpleCloth) {
            scene.cloth.resetToInitialState();
        }
    };
    
    (window as any).dropCloth = () => {
        const scene = getCurrentScene();
        if (scene.cloth instanceof Cloth) {
            scene.cloth.drop();
        } else if (scene.cloth instanceof SimpleCloth) {
            scene.cloth.drop();
        }
    };
}

// Start application
init().catch((error) => {
    console.error('Failed to initialize:', error);
    document.body.innerHTML = `<div style="color: red; padding: 20px;">
        <h1>WebGPU Initialization Failed</h1>
        <p>${error.message}</p>
        <p>Make sure you're using a browser that supports WebGPU (Chrome 113+, Edge 113+, or Safari 18+).</p>
    </div>`;
});

