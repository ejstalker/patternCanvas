import { mat4 } from 'gl-matrix';
import { mat4ToArray } from './utils/math';
import { Cloth } from './Cloth';
import { SimpleCloth } from './SimpleCloth';
import type { ClothSimulator } from './sim/ClothSimulator';
import { Ground } from './Ground';
import { Camera } from './Camera';
import floorVertexShaderCode from './shaders/floor.vert.wgsl?raw';
import floorFragmentShaderCode from './shaders/floor.frag.wgsl?raw';
import gridVertexShaderCode from './shaders/grid.vert.wgsl?raw';
import gridFragmentShaderCode from './shaders/grid.frag.wgsl?raw';
import { inchesToOrbitWorld } from './sim/cameraDefaults';

export type RenderableCloth = Cloth | SimpleCloth | ClothSimulator;

/**
 * Flat alpha-blended quad overlay (the quadrant snap grid). Vertices are
 * triangle-list xyz triples in world space.
 */
export type QuadOverlay = {
  cells: Float32Array;
  highlight?: Float32Array | null;
};

export class Renderer {
    private device: GPUDevice;
    private context: GPUCanvasContext;
    private format: GPUTextureFormat;
    private depthTexture: GPUTexture;
    private depthTextureView: GPUTextureView;
    private canvas: HTMLCanvasElement;

    private renderPipeline: GPURenderPipeline | null = null;
    /** Cloth with optional per-vertex strain colors. */
    private clothPipeline: GPURenderPipeline | null = null;
    private floorPipeline: GPURenderPipeline | null = null;
    private wireframePipeline: GPURenderPipeline | null = null;
    private linePipeline: GPURenderPipeline | null = null;
    /** Alpha-blended quad overlay (quadrant snap grid). */
    private gridPipeline: GPURenderPipeline | null = null;
    private gridUniformBuffer: GPUBuffer | null = null;
    private gridBindGroup: GPUBindGroup | null = null;
    private gridCellBuffer: GPUBuffer | null = null;
    private gridHighlightBuffer: GPUBuffer | null = null;
    private gridCellVertexCount = 0;
    private gridHighlightVertexCount = 0;
    private gridOverlay: QuadOverlay | null = null;
    /** Cloth model + viewProj — do not overwrite mid-frame after cloth draw is encoded. */
    private uniformBuffer: GPUBuffer | null = null;
    /** Sphere collider model matrix. */
    private objectUniformBuffer: GPUBuffer | null = null;
    /** Flat floor model matrix + gradient params. */
    private floorUniformBuffer: GPUBuffer | null = null;
    /** Seam / wireframe overlay model matrix. */
    private overlayUniformBuffer: GPUBuffer | null = null;
    /** Cloth lighting — written once per frame. */
    private lightingBuffer: GPUBuffer | null = null;
    /** Sphere collider lighting. */
    private objectLightingBuffer: GPUBuffer | null = null;
    /** Flat floor lighting. */
    private floorLightingBuffer: GPUBuffer | null = null;
    /** Seam / wireframe overlay lighting (bright unlit colors). */
    private overlayLightingBuffer: GPUBuffer | null = null;

    private vertexShader: GPUShaderModule | null = null;
    private fragmentShader: GPUShaderModule | null = null;
    
    private wireframeMode: boolean = false;
    private wireframeColor: [number, number, number] = [0.0, 1.0, 1.0]; // Bright cyan wireframe

    // inital lighting and color parameters
    private light1Color: [number, number, number] = [0.96, 0.98, 1.0];
    private light1Position: [number, number, number] = [1, -1.5 + inchesToOrbitWorld(24), 2];
    private light2Color: [number, number, number] = [0.4, 0.4, 0.4];
    private light2Position: [number, number, number] = [-1, 5, -2];
    private clothColor: [number, number, number] = [0.9, 0.01, 0.01];
    private groundColor: [number, number, number] = [0.5, 0.4, 0.35];

    constructor(
        device: GPUDevice,
        context: GPUCanvasContext,
        format: GPUTextureFormat,
        depthTexture: GPUTexture,
        depthTextureView: GPUTextureView,
        canvas: HTMLCanvasElement
    ) {
        this.device = device;
        this.context = context;
        this.format = format;
        this.depthTexture = depthTexture;
        this.depthTextureView = depthTextureView;
        this.canvas = canvas;
    }

    async initialize(vertexShaderCode: string, fragmentShaderCode: string): Promise<void> {
        // Create shader modules
        this.vertexShader = this.device.createShaderModule({ code: vertexShaderCode });
        this.fragmentShader = this.device.createShaderModule({ code: fragmentShaderCode });

        // Create uniform buffers
        // Uniforms: viewProj (16 floats) + model (16 floats) = 32 floats * 4 bytes = 128 bytes
        // Separate buffers per draw group: queue.writeBuffer before submit would otherwise
        // leave every draw seeing only the *last* written contents of a shared buffer.
        this.uniformBuffer = this.device.createBuffer({
            size: 128,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.objectUniformBuffer = this.device.createBuffer({
            size: 128,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.floorUniformBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.overlayUniformBuffer = this.device.createBuffer({
            size: 128,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        // viewProj (64) + color (16)
        this.gridUniformBuffer = this.device.createBuffer({
            size: 80,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Lighting uniforms: 6 vec3s = 18 floats * 4 bytes = 72 bytes, but align to 256 for safety
        this.lightingBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.objectLightingBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.floorLightingBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.overlayLightingBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Create render pipeline (filled triangles)
        this.renderPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.vertexShader,
                entryPoint: 'main',
                buffers: [
                    {
                        arrayStride: 12, // 3 floats * 4 bytes
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
                        ],
                    },
                    {
                        arrayStride: 12, // 3 floats * 4 bytes
                        attributes: [
                            { shaderLocation: 1, offset: 0, format: 'float32x3' }, // normal
                        ],
                    },
                ],
            },
            fragment: {
                module: this.fragmentShader,
                entryPoint: 'main',
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });

        this.clothPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.vertexShader,
                entryPoint: 'mainColored',
                buffers: [
                    {
                        arrayStride: 12,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' },
                        ],
                    },
                    {
                        arrayStride: 12,
                        attributes: [
                            { shaderLocation: 1, offset: 0, format: 'float32x3' },
                        ],
                    },
                    {
                        arrayStride: 12,
                        attributes: [
                            { shaderLocation: 2, offset: 0, format: 'float32x3' },
                        ],
                    },
                ],
            },
            fragment: {
                module: this.fragmentShader,
                entryPoint: 'mainColored',
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });

        const floorVertexShader = this.device.createShaderModule({ code: floorVertexShaderCode });
        const floorFragmentShader = this.device.createShaderModule({ code: floorFragmentShaderCode });
        this.floorPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: floorVertexShader,
                entryPoint: 'main',
                buffers: [
                    {
                        arrayStride: 12,
                        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
                    },
                    {
                        arrayStride: 12,
                        attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
                    },
                ],
            },
            fragment: {
                module: floorFragmentShader,
                entryPoint: 'main',
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });

        // Create wireframe pipeline (triangles for quad-based wireframe)
        this.wireframePipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.vertexShader,
                entryPoint: 'main',
                buffers: [
                    {
                        arrayStride: 12, // 3 floats * 4 bytes
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
                        ],
                    },
                    {
                        arrayStride: 12, // 3 floats * 4 bytes
                        attributes: [
                            { shaderLocation: 1, offset: 0, format: 'float32x3' }, // normal
                        ],
                    },
                ],
            },
            fragment: {
                module: this.fragmentShader,
                entryPoint: 'main',
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'triangle-list', // Use triangles for quad-based wireframe
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: false, // Don't write depth for wireframe
                depthCompare: 'less', // Render wireframe when closer or equal (ensures it's visible)
                format: 'depth24plus',
            },
        });

        // Line-list pipeline for sewing bond overlays in the drape sim
        this.linePipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.vertexShader,
                entryPoint: 'main',
                buffers: [
                    {
                        arrayStride: 12,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' },
                        ],
                    },
                    {
                        arrayStride: 12,
                        attributes: [
                            { shaderLocation: 1, offset: 0, format: 'float32x3' },
                        ],
                    },
                ],
            },
            fragment: {
                module: this.fragmentShader,
                entryPoint: 'main',
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'line-list',
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: false,
                depthCompare: 'less',
                format: 'depth24plus',
            },
        });

        // Alpha-blended flat quads for the quadrant snap grid.
        const gridVertexShader = this.device.createShaderModule({ code: gridVertexShaderCode });
        const gridFragmentShader = this.device.createShaderModule({ code: gridFragmentShaderCode });
        this.gridPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: gridVertexShader,
                entryPoint: 'main',
                buffers: [
                    {
                        arrayStride: 12,
                        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
                    },
                ],
            },
            fragment: {
                module: gridFragmentShader,
                entryPoint: 'main',
                targets: [
                    {
                        format: this.format,
                        blend: {
                            color: {
                                srcFactor: 'src-alpha',
                                dstFactor: 'one-minus-src-alpha',
                                operation: 'add',
                            },
                            // Keep the canvas opaque (clear alpha is 1).
                            alpha: {
                                srcFactor: 'one',
                                dstFactor: 'one-minus-src-alpha',
                                operation: 'add',
                            },
                        },
                    },
                ],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                depthWriteEnabled: false,
                depthCompare: 'less-equal',
                format: 'depth24plus',
            },
        });
        this.gridBindGroup = this.device.createBindGroup({
            layout: this.gridPipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: this.gridUniformBuffer! } }],
        });
    }

    /** Set (or clear) the flat quad overlay drawn with the scene. */
    setGridOverlay(overlay: QuadOverlay | null): void {
        this.gridOverlay = overlay;
        if (!overlay) {
            this.gridCellVertexCount = 0;
            this.gridHighlightVertexCount = 0;
            return;
        }
        this.gridCellBuffer = this.writeOverlayBuffer(
            this.gridCellBuffer,
            overlay.cells
        );
        this.gridCellVertexCount = Math.floor(overlay.cells.length / 3);
        if (overlay.highlight && overlay.highlight.length > 0) {
            this.gridHighlightBuffer = this.writeOverlayBuffer(
                this.gridHighlightBuffer,
                overlay.highlight
            );
            this.gridHighlightVertexCount = Math.floor(overlay.highlight.length / 3);
        } else {
            this.gridHighlightVertexCount = 0;
        }
    }

    /** Reuse a vertex buffer when it is large enough, otherwise reallocate. */
    private writeOverlayBuffer(current: GPUBuffer | null, data: Float32Array): GPUBuffer {
        let buffer = current;
        if (!buffer || buffer.size < data.byteLength) {
            buffer?.destroy();
            buffer = this.device.createBuffer({
                size: Math.max(data.byteLength, 12),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                label: 'grid-overlay',
            });
        }
        // Copy into an ArrayBuffer-backed view so the typings accept it as
        // GPUAllowSharedBufferSource (matches XpbdGpuEngine.gpuData).
        const bytes = new Uint8Array(data.byteLength);
        bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        this.device.queue.writeBuffer(buffer, 0, bytes);
        return buffer;
    }

    private drawGridOverlay(
        pass: GPURenderPassEncoder,
        viewProj: mat4,
        buffer: GPUBuffer | null,
        vertexCount: number,
        color: [number, number, number, number]
    ): void {
        if (!buffer || vertexCount <= 0 || !this.gridPipeline || !this.gridUniformBuffer) return;
        const data = new Float32Array(20);
        data.set(mat4ToArray(viewProj), 0);
        data.set(color, 16);
        this.device.queue.writeBuffer(this.gridUniformBuffer, 0, data);
        pass.setPipeline(this.gridPipeline);
        if (this.gridBindGroup) pass.setBindGroup(0, this.gridBindGroup);
        pass.setVertexBuffer(0, buffer);
        pass.draw(vertexCount);
    }

    resize(width: number, height: number): void {
        this.canvas.width = width;
        this.canvas.height = height;

        // Recreate depth texture
        this.depthTexture.destroy();
        this.depthTexture = this.device.createTexture({
            size: [width, height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthTextureView = this.depthTexture.createView();
    }

    setLight1Color(r: number, g: number, b: number): void {
        this.light1Color = [r, g, b];
    }

    setLight1Position(x: number, y: number, z: number): void {
        this.light1Position = [x, y, z];
    }

    setLight2Color(r: number, g: number, b: number): void {
        this.light2Color = [r, g, b];
    }

    setLight2Position(x: number, y: number, z: number): void {
        this.light2Position = [x, y, z];
    }

    setClothColor(r: number, g: number, b: number): void {
        this.clothColor = [r, g, b];
    }

    setGroundColor(r: number, g: number, b: number): void {
        this.groundColor = [r, g, b];
    }

    setWireframeMode(enabled: boolean): void {
        this.wireframeMode = enabled;
    }

    getWireframeMode(): boolean {
        return this.wireframeMode;
    }

    render(cloth: RenderableCloth, camera: Camera): void {
        const viewProj = camera.getViewProjectMtx();
        const model = cloth.getModelMatrix();

        // Update uniform buffer
        const uniformData = new Float32Array(32);
        uniformData.set(mat4ToArray(viewProj), 0);
        uniformData.set(mat4ToArray(model), 16);
        this.device.queue.writeBuffer(this.uniformBuffer!, 0, uniformData);

        // Normalize light directions
        const light1Len = Math.sqrt(
            this.light1Position[0] ** 2 + 
            this.light1Position[1] ** 2 + 
            this.light1Position[2] ** 2
        );
        const light2Len = Math.sqrt(
            this.light2Position[0] ** 2 + 
            this.light2Position[1] ** 2 + 
            this.light2Position[2] ** 2
        );

        // Update lighting buffer - prepare base lighting data
        // In WGSL, vec3 is aligned to 16 bytes (4 floats), so layout is:
        // ambientColor: offset 0 (indices 0-2, padding at 3)
        // lightDirection: offset 16 (indices 4-6, padding at 7)
        // lightColor: offset 32 (indices 8-10, padding at 11)
        // lightDirection2: offset 48 (indices 12-14, padding at 15)
        // lightColor2: offset 64 (indices 16-18, padding at 19)
        // diffuseColor: offset 80 (indices 20-22, padding at 23)
        const lightingData = new Float32Array(64); // 256 bytes / 4
        
        // Always use normal lighting for the cloth (same as when wireframe is off)
        // Wireframe will have its own special lighting settings when rendered
        lightingData[0] = 0.15;
        lightingData[1] = 0.15;
        lightingData[2] = 0.15;
        lightingData[3] = 0.0; // padding
        // Light 1 direction (normalized)
        lightingData[4] = light1Len > 0 ? this.light1Position[0] / light1Len : 0;
        lightingData[5] = light1Len > 0 ? this.light1Position[1] / light1Len : 0;
        lightingData[6] = light1Len > 0 ? this.light1Position[2] / light1Len : 0;
        lightingData[7] = 0.0; // padding
        // Light 1 color
        lightingData[8] = this.light1Color[0];
        lightingData[9] = this.light1Color[1];
        lightingData[10] = this.light1Color[2];
        lightingData[11] = 0.0; // padding
        // Light 2 direction (normalized)
        lightingData[12] = light2Len > 0 ? this.light2Position[0] / light2Len : 0;
        lightingData[13] = light2Len > 0 ? this.light2Position[1] / light2Len : 0;
        lightingData[14] = light2Len > 0 ? this.light2Position[2] / light2Len : 0;
        lightingData[15] = 0.0; // padding
        // Light 2 color
        lightingData[16] = this.light2Color[0];
        lightingData[17] = this.light2Color[1];
        lightingData[18] = this.light2Color[2];
        lightingData[19] = 0.0; // padding
        // Diffuse color (cloth color); [23] = useVertexColor for strain map
        lightingData[20] = this.clothColor[0];
        lightingData[21] = this.clothColor[1];
        lightingData[22] = this.clothColor[2];
        const colorBuffer =
            'getColorBuffer' in cloth && typeof (cloth as ClothSimulator).getColorBuffer === 'function'
                ? (cloth as ClothSimulator).getColorBuffer?.() ?? null
                : null;
        const useVertexColor =
            !!colorBuffer &&
            'isStrainMapEnabled' in cloth &&
            typeof (cloth as ClothSimulator).isStrainMapEnabled === 'function' &&
            !!(cloth as ClothSimulator).isStrainMapEnabled?.();
        lightingData[23] = useVertexColor ? 1.0 : 0.0;

        // Write the buffer - WebGPU queue operations are automatically ordered
        // However, to ensure the write completes before rendering, we'll write it and then
        // create the encoder (which should ensure ordering)
        this.device.queue.writeBuffer(this.lightingBuffer!, 0, lightingData);

        // Get current texture from canvas
        const texture = this.context.getCurrentTexture();
        const textureView = texture.createView();

        // Create command encoder AFTER buffer write
        // In WebGPU, queue operations are ordered, so writes complete before commands execute
        const encoder = this.device.createCommandEncoder();
        
        // IMPORTANT: Create bind group AFTER buffer write to ensure it references updated buffer
        // Note: Bind groups just reference the buffer, they don't cache data
        const clothPipeline =
            colorBuffer && this.clothPipeline ? this.clothPipeline : this.renderPipeline!;
        const clothBindGroup = this.createBindGroup(
            clothPipeline,
            this.uniformBuffer!,
            this.lightingBuffer!
        );
        
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: textureView,
                    clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        // Render cloth - check if buffers are valid
        const positionBuffer = cloth.getPositionBuffer();
        const normalBuffer = cloth.getNormalBuffer();
        const indexBuffer = cloth.getIndexBuffer();
        
        if (!positionBuffer || !normalBuffer || !indexBuffer) {
            console.warn('Cloth buffers not ready, skipping render');
            pass.end();
            this.device.queue.submit([encoder.finish()]);
            return;
        }

        // Always render filled triangles first
        // (Cloth uses normal lighting regardless of wireframe mode)
        // Bind group was created AFTER buffer write to ensure it uses updated data
        pass.setPipeline(clothPipeline);
        pass.setBindGroup(0, clothBindGroup);
        pass.setVertexBuffer(0, positionBuffer);
        pass.setVertexBuffer(1, normalBuffer);
        if (colorBuffer && clothPipeline === this.clothPipeline) {
            pass.setVertexBuffer(2, colorBuffer);
        }
        pass.setIndexBuffer(indexBuffer, cloth.getIndexFormat());
        pass.drawIndexed(cloth.getIndexCount());

        // If wireframe mode is enabled, overlay wireframe quads on top
        if (this.wireframeMode && this.wireframePipeline) {
            const wireframeBuffers = cloth.getWireframeBuffers();
            if (wireframeBuffers && wireframeBuffers.indexCount > 0) {
                // Create wireframe lighting data with bright cyan color
                const wireframeLightingData = new Float32Array(64);
                wireframeLightingData.set(lightingData);
                // Set diffuse color to bright cyan for wireframe
                wireframeLightingData[20] = this.wireframeColor[0];
                wireframeLightingData[21] = this.wireframeColor[1];
                wireframeLightingData[22] = this.wireframeColor[2];
                // Make ambient VERY high so wireframe is always bright and visible
                wireframeLightingData[0] = 2.0; // Overbright for maximum visibility
                wireframeLightingData[1] = 2.0;
                wireframeLightingData[2] = 2.0;
                // Disable directional lights for wireframe (make it pure bright cyan)
                wireframeLightingData[8] = 0.0;
                wireframeLightingData[9] = 0.0;
                wireframeLightingData[10] = 0.0;
                wireframeLightingData[16] = 0.0;
                wireframeLightingData[17] = 0.0;
                wireframeLightingData[18] = 0.0;
                // Use overlay buffers so cloth lighting stays intact
                this.device.queue.writeBuffer(this.overlayUniformBuffer!, 0, uniformData);
                this.device.queue.writeBuffer(this.overlayLightingBuffer!, 0, wireframeLightingData);
                
                // Render wireframe quads (triangles) on top
                pass.setPipeline(this.wireframePipeline);
                pass.setBindGroup(
                    0,
                    this.createBindGroup(
                        this.wireframePipeline,
                        this.overlayUniformBuffer!,
                        this.overlayLightingBuffer!
                    )
                );
                pass.setVertexBuffer(0, wireframeBuffers.positionBuffer);
                pass.setVertexBuffer(1, wireframeBuffers.normalBuffer);
                pass.setIndexBuffer(wireframeBuffers.indexBuffer, wireframeBuffers.indexFormat);
                pass.drawIndexed(wireframeBuffers.indexCount);
            } else {
                // Fallback: disable wireframe if buffers not available
                console.warn('Wireframe buffers not available, disabling wireframe mode');
                this.wireframeMode = false;
                const wireframeToggle = document.getElementById('wireframeToggle') as HTMLInputElement;
                if (wireframeToggle) wireframeToggle.checked = false;
            }
        }

        // Render ground (sphere) — dedicated object buffers so cloth stays correctly lit
        const ground = cloth.getGround();
        const groundModel = ground.getModelMatrix();
        const groundUniformData = new Float32Array(32);
        groundUniformData.set(mat4ToArray(viewProj), 0);
        groundUniformData.set(mat4ToArray(groundModel), 16);
        this.device.queue.writeBuffer(this.objectUniformBuffer!, 0, groundUniformData);

        const groundLightingData = new Float32Array(64);
        groundLightingData.set(lightingData);
        groundLightingData[20] = this.groundColor[0];
        groundLightingData[21] = this.groundColor[1];
        groundLightingData[22] = this.groundColor[2];
        this.device.queue.writeBuffer(this.objectLightingBuffer!, 0, groundLightingData);

        const objectBindGroup = this.createBindGroup(
            this.renderPipeline!,
            this.objectUniformBuffer!,
            this.objectLightingBuffer!
        );
        pass.setPipeline(this.renderPipeline!);
        pass.setBindGroup(0, objectBindGroup);
        pass.setVertexBuffer(0, ground.getPositionBuffer());
        pass.setVertexBuffer(1, ground.getNormalBuffer());
        pass.setIndexBuffer(ground.getIndexBuffer(), 'uint32');
        pass.drawIndexed(ground.getIndexCount());

        // Optional flat floor under the avatar
        const floor =
          'getFloor' in cloth && typeof cloth.getFloor === 'function' ? cloth.getFloor?.() : null;
        if (floor) {
          const floorModel = floor.getModelMatrix();

          if (floor.usesRadialGradient?.() && this.floorPipeline) {
            const floorUniformData = new Float32Array(36);
            floorUniformData.set(mat4ToArray(viewProj), 0);
            floorUniformData.set(mat4ToArray(floorModel), 16);
            floorUniformData[32] = floor.getGradientHalfExtent?.() ?? 1;
            this.device.queue.writeBuffer(this.floorUniformBuffer!, 0, floorUniformData);

            pass.setPipeline(this.floorPipeline);
            pass.setBindGroup(0, this.createFloorBindGroup());
            pass.setVertexBuffer(0, floor.getPositionBuffer());
            pass.setVertexBuffer(1, floor.getNormalBuffer());
            pass.setIndexBuffer(floor.getIndexBuffer(), 'uint32');
            pass.drawIndexed(floor.getIndexCount());
          } else {
            const floorUniformData = new Float32Array(32);
            floorUniformData.set(mat4ToArray(viewProj), 0);
            floorUniformData.set(mat4ToArray(floorModel), 16);
            this.device.queue.writeBuffer(this.floorUniformBuffer!, 0, floorUniformData);

            const floorLightingData = new Float32Array(64);
            floorLightingData.set(lightingData);
            floorLightingData[20] = this.groundColor[0] * 0.75;
            floorLightingData[21] = this.groundColor[1] * 0.78;
            floorLightingData[22] = this.groundColor[2] * 0.85;
            this.device.queue.writeBuffer(this.floorLightingBuffer!, 0, floorLightingData);

            pass.setPipeline(this.renderPipeline!);
            pass.setBindGroup(
              0,
              this.createBindGroup(
                this.renderPipeline!,
                this.floorUniformBuffer!,
                this.floorLightingBuffer!
              )
            );
            pass.setVertexBuffer(0, floor.getPositionBuffer());
            pass.setVertexBuffer(1, floor.getNormalBuffer());
            pass.setIndexBuffer(floor.getIndexBuffer(), 'uint32');
            pass.drawIndexed(floor.getIndexCount());
          }
        }

        // Sewing bond lines — overlay buffers only (never touch cloth lighting)
        const seamCount =
          'getSeamLineVertexCount' in cloth && typeof cloth.getSeamLineVertexCount === 'function'
            ? (cloth.getSeamLineVertexCount?.() ?? 0)
            : 0;
        if (seamCount > 0 && this.linePipeline) {
          const seamPos =
            'getSeamLinePositionBuffer' in cloth
              ? (cloth as ClothSimulator).getSeamLinePositionBuffer?.() ?? null
              : null;
          const seamNrm =
            'getSeamLineNormalBuffer' in cloth
              ? (cloth as ClothSimulator).getSeamLineNormalBuffer?.() ?? null
              : null;
          if (seamPos && seamNrm) {
            const seamUniform = new Float32Array(32);
            seamUniform.set(mat4ToArray(viewProj), 0);
            seamUniform.set(mat4ToArray(model), 16);
            this.device.queue.writeBuffer(this.overlayUniformBuffer!, 0, seamUniform);

            const seamLighting = new Float32Array(64);
            seamLighting.set(lightingData);
            // Bright gold / amber — matches pattern-editor seam accent
            seamLighting[0] = 1.4;
            seamLighting[1] = 1.2;
            seamLighting[2] = 0.4;
            seamLighting[8] = 0;
            seamLighting[9] = 0;
            seamLighting[10] = 0;
            seamLighting[16] = 0;
            seamLighting[17] = 0;
            seamLighting[18] = 0;
            seamLighting[20] = 1.0;
            seamLighting[21] = 0.78;
            seamLighting[22] = 0.2;
            this.device.queue.writeBuffer(this.overlayLightingBuffer!, 0, seamLighting);

            pass.setPipeline(this.linePipeline);
            pass.setBindGroup(
              0,
              this.createBindGroup(
                this.linePipeline,
                this.overlayUniformBuffer!,
                this.overlayLightingBuffer!
              )
            );
            pass.setVertexBuffer(0, seamPos);
            pass.setVertexBuffer(1, seamNrm);
            pass.draw(seamCount);
          }
        }

        // Quadrant snap grid — faint base cells, brighter hovered cell.
        if (this.gridOverlay) {
          this.drawGridOverlay(
            pass,
            viewProj,
            this.gridCellBuffer,
            this.gridCellVertexCount,
            [0.78, 0.82, 0.9, 0.25]
          );
          this.drawGridOverlay(
            pass,
            viewProj,
            this.gridHighlightBuffer,
            this.gridHighlightVertexCount,
            [0.83, 0.63, 0.09, 0.55]
          );
        }

        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    private createFloorBindGroup(): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.floorPipeline!.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.floorUniformBuffer! },
                },
            ],
        });
    }

    private createBindGroup(
        pipeline: GPURenderPipeline,
        uniformBuffer: GPUBuffer,
        lightingBuffer: GPUBuffer
    ): GPUBindGroup {
        return this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: uniformBuffer,
                    },
                },
                {
                    binding: 1,
                    resource: {
                        buffer: lightingBuffer,
                    },
                },
            ],
        });
    }
}

