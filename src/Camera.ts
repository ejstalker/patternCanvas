import { mat4, vec3 } from 'gl-matrix';
import { perspective, eulerAngleX, eulerAngleY, multiply, inverse } from './utils/math';

export class Camera {
    private fov: number = 45.0;
    private aspect: number = 1.33;
    private nearClip: number = 0.1;
    private farClip: number = 100.0;

    private distance: number = 10.0;
    private azimuth: number = 0.0;
    private incline: number = 20.0;
    private panX: number = 0.0;
    private panY: number = 0.0;
    private panZ: number = 0.0;
    private orthographic: boolean = false;

    private viewProjectMtx: mat4 = mat4.create();
    /** World-space eye position (updated on every `update()`). */
    private eye: vec3 = vec3.create();

    constructor() {
        this.reset();
    }

    update(): void {
        const world = mat4.create();
        mat4.translate(world, world, [0, 0, this.distance]);

        const rotY = eulerAngleY((-this.azimuth * Math.PI) / 180);
        const rotX = eulerAngleX((-this.incline * Math.PI) / 180);
        const rotYX = multiply(rotY, rotX);
        const worldRotated = multiply(rotYX, world);

        const worldFinal = mat4.create();
        mat4.copy(worldFinal, worldRotated);
        mat4.translate(worldFinal, worldFinal, [-this.panX, -this.panY, -this.panZ]);
        // worldFinal is the camera's world transform; its translation is the eye.
        vec3.set(this.eye, worldFinal[12], worldFinal[13], worldFinal[14]);

        const view = inverse(worldFinal);

        let project: mat4;
        if (this.orthographic) {
            // Match perspective frustum height at the orbit distance so zoom feels consistent.
            const halfH = Math.max(0.01, this.distance * Math.tan((this.fov * Math.PI) / 360));
            const halfW = halfH * this.aspect;
            project = mat4.create();
            // WebGPU clip Z is [0,1] — OpenGL mat4.ortho puts the scene at z<0 and everything disappears.
            mat4.orthoZO(project, -halfW, halfW, -halfH, halfH, this.nearClip, this.farClip);
        } else {
            project = perspective(this.fov, this.aspect, this.nearClip, this.farClip);
        }

        this.viewProjectMtx = multiply(project, view);
    }

    reset(): void {
        this.fov = 45.0;
        this.aspect = 1.33;
        this.nearClip = 0.1;
        this.farClip = 100.0;
        this.distance = 10.0;
        this.azimuth = 0.0;
        this.incline = 20.0;
        this.panX = 0.0;
        this.panY = 0.0;
        this.panZ = 0.0;
        this.orthographic = false;
    }

    setAspect(aspect: number): void {
        this.aspect = aspect;
    }

    setDistance(distance: number): void {
        this.distance = distance;
    }

    setAzimuth(azimuth: number): void {
        this.azimuth = azimuth;
    }

    setIncline(incline: number): void {
        this.incline = Math.max(-89.9, Math.min(89.9, incline));
    }

    getDistance(): number {
        return this.distance;
    }

    getAzimuth(): number {
        return this.azimuth;
    }

    getIncline(): number {
        return this.incline;
    }

    setOrthographic(enabled: boolean): void {
        this.orthographic = enabled;
    }

    isOrthographic(): boolean {
        return this.orthographic;
    }

    toggleOrthographic(): void {
        this.orthographic = !this.orthographic;
    }

    setPanX(panX: number): void {
        this.panX = panX;
    }

    setPanY(panY: number): void {
        this.panY = panY;
    }

    setPanZ(panZ: number): void {
        this.panZ = panZ;
    }

    getPanX(): number {
        return this.panX;
    }

    getPanY(): number {
        return this.panY;
    }

    getPanZ(): number {
        return this.panZ;
    }

    addPan(deltaX: number, deltaY: number, deltaZ: number): void {
        this.panX += deltaX;
        this.panY += deltaY;
        this.panZ += deltaZ;
    }

    /** Screen-space pan along camera right/up (Blender Shift+MMB style). */
    panScreen(dxPx: number, dyPx: number, viewportHeight: number): void {
        const worldPerPixel =
            (2 * this.distance * Math.tan((this.fov * Math.PI) / 360)) / Math.max(viewportHeight, 1);
        const az = (this.azimuth * Math.PI) / 180;
        const inc = (this.incline * Math.PI) / 180;
        const right = vec3.fromValues(Math.cos(az), 0, -Math.sin(az));
        const up = vec3.fromValues(
            -Math.sin(az) * Math.sin(inc),
            Math.cos(inc),
            -Math.cos(az) * Math.sin(inc)
        );
        const scale = worldPerPixel;
        this.panX += (-dxPx * right[0] + dyPx * up[0]) * scale;
        this.panY += (-dxPx * right[1] + dyPx * up[1]) * scale;
        this.panZ += (-dxPx * right[2] + dyPx * up[2]) * scale;
    }

    /** Raise or lower the orbit target on world Y (Shift-drag in the sim viewport). */
    panOrbitVertical(dyPx: number, viewportHeight: number): void {
        const worldPerPixel =
            (2 * this.distance * Math.tan((this.fov * Math.PI) / 360)) / Math.max(viewportHeight, 1);
        this.panY -= dyPx * worldPerPixel;
    }

    /** World-space camera position (valid after `update()`). */
    getEyePosition(): vec3 {
        return vec3.clone(this.eye);
    }

    getViewProjectMtx(): mat4 {
        return this.viewProjectMtx;
    }
}
