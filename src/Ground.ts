import { vec3, mat4 } from 'gl-matrix';
import { translate, identity } from './utils/math';

const EPSILON = 0.01;

export class Ground {
    private points: vec3[] = [];
    private normals: vec3[] = [];
    private indices: number[] = [];
    private model: mat4 = identity();
    private groundLevel: number = 0.0;
    private planeSize: number;
    private radialGradient: boolean;

    // WebGPU resources
    private positionBuffer: GPUBuffer | null = null;
    private normalBuffer: GPUBuffer | null = null;
    private indexBuffer: GPUBuffer | null = null;
    private indexCount: number = 0;

    constructor(
        topleft: vec3,
        size: number,
        device: GPUDevice,
        options?: { radialGradient?: boolean }
    ) {
        this.planeSize = size;
        this.radialGradient = options?.radialGradient ?? false;
        this.groundLevel = topleft[1];
        this.model = translate([0.0, topleft[1] - EPSILON, 0.0]);

        // Create ground plane vertices
        this.points.push([topleft[0], topleft[1], topleft[2]]);
        this.points.push([topleft[0] + size, topleft[1], topleft[2]]);
        this.points.push([topleft[0], topleft[1], topleft[2] + size]);
        this.points.push([topleft[0] + size, topleft[1], topleft[2] + size]);

        // All normals point up
        for (let i = 0; i < 4; i++) {
            this.normals.push([0.0, 1.0, 0.0]);
        }

        // Two triangles
        this.indices = [0, 2, 3, 0, 3, 1];
        this.indexCount = this.indices.length;

        // Create WebGPU buffers
        this.createBuffers(device);
    }

    private createBuffers(device: GPUDevice): void {
        // Position buffer
        const positions = new Float32Array(this.points.length * 3);
        for (let i = 0; i < this.points.length; i++) {
            positions[i * 3] = this.points[i][0];
            positions[i * 3 + 1] = this.points[i][1];
            positions[i * 3 + 2] = this.points[i][2];
        }

        this.positionBuffer = device.createBuffer({
            size: positions.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.positionBuffer, 0, positions);

        // Normal buffer
        const normals = new Float32Array(this.normals.length * 3);
        for (let i = 0; i < this.normals.length; i++) {
            normals[i * 3] = this.normals[i][0];
            normals[i * 3 + 1] = this.normals[i][1];
            normals[i * 3 + 2] = this.normals[i][2];
        }

        this.normalBuffer = device.createBuffer({
            size: normals.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.normalBuffer, 0, normals);

        // Index buffer
        const indices = new Uint32Array(this.indices);
        this.indexBuffer = device.createBuffer({
            size: indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.indexBuffer, 0, indices);
    }

    setGroundLevel(level: number): void {
        this.groundLevel = level;
        this.model = translate([0.0, level - EPSILON, 0.0]);
    }

    getModelMatrix(): mat4 {
        return this.model;
    }

    getPositionBuffer(): GPUBuffer {
        return this.positionBuffer!;
    }

    getNormalBuffer(): GPUBuffer {
        return this.normalBuffer!;
    }

    getIndexBuffer(): GPUBuffer {
        return this.indexBuffer!;
    }

    getIndexCount(): number {
        return this.indexCount;
    }

    usesRadialGradient(): boolean {
        return this.radialGradient;
    }

    /** Half-width of the square floor — used for radial gradient falloff. */
    getGradientHalfExtent(): number {
        return this.planeSize * 0.5;
    }

    destroy(): void {
        // Buffers will be garbage collected, but we could explicitly destroy them if needed
    }
}

