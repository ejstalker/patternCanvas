import { mat4, vec3, vec4 } from 'gl-matrix';

// Re-export commonly used types
export { mat4, vec3, vec4 } from 'gl-matrix';

// Helper to convert mat4 to Float32Array for WebGPU
export function mat4ToArray(m: mat4): Float32Array {
    return new Float32Array(m);
}

// Helper to create a WebGPU-friendly perspective matrix (clip Z in [0, 1]).
export function perspective(fov: number, aspect: number, near: number, far: number): mat4 {
    const m = mat4.create();
    mat4.perspectiveZO(m, (fov * Math.PI) / 180, aspect, near, far);
    return m;
}

// Helper to create euler rotation matrix
export function eulerAngleX(angle: number): mat4 {
    const m = mat4.create();
    mat4.rotateX(m, m, angle);
    return m;
}

export function eulerAngleY(angle: number): mat4 {
    const m = mat4.create();
    mat4.rotateY(m, m, angle);
    return m;
}

export function eulerAngleZ(angle: number): mat4 {
    const m = mat4.create();
    mat4.rotateZ(m, m, angle);
    return m;
}

// Helper to create translation matrix
export function translate(v: vec3): mat4 {
    const m = mat4.create();
    mat4.translate(m, m, v);
    return m;
}

// Helper to create identity matrix
export function identity(): mat4 {
    return mat4.create();
}

// Helper to invert matrix
export function inverse(m: mat4): mat4 {
    const result = mat4.create();
    mat4.invert(result, m);
    return result;
}

// Helper to multiply matrices
export function multiply(a: mat4, b: mat4): mat4 {
    const result = mat4.create();
    mat4.multiply(result, a, b);
    return result;
}

