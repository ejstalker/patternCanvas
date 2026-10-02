import { vec3 } from 'gl-matrix';

const EPSILON = 1e-6;
const BASE_COLLISION_MARGIN = 0.05; // Base margin for plane collision
/** Default fraction of tangential velocity retained per contact (legacy). */
const DEFAULT_CONTACT_FRICTION_RETAIN = 0.85;
const FLOOR_NORMAL = vec3.fromValues(0, 1, 0);

export class Particle {
    public position: vec3;
    public normal: vec3;
    private velocity: vec3;
    private force: vec3;
    private prevForce: vec3;
    private isFixed: boolean = false;

    private mass: number;
    private gravityAcce: number;
    private groundPos: number;
    private sphereCenter: vec3 | null = null;
    private sphereRadius: number | null = null;
    private edgeLength: number = 0; // Distance to adjacent particles (for adaptive margin)
    /** Tangential velocity retain on contact (1 = ice, 0 = full stick). */
    private contactFrictionRetain = DEFAULT_CONTACT_FRICTION_RETAIN;

    constructor(
        position: vec3,
        normal: vec3,
        mass: number,
        gravityAcce: number,
        groundPos: number,
        sphereCenter?: vec3,
        sphereRadius?: number
    ) {
        this.position = position;
        this.normal = normal;
        this.mass = mass;
        this.gravityAcce = gravityAcce;
        this.groundPos = groundPos;
        this.velocity = vec3.create();
        this.force = vec3.create();
        this.prevForce = vec3.create();
        
        if (sphereCenter && sphereRadius !== undefined) {
            this.sphereCenter = sphereCenter;
            this.sphereRadius = sphereRadius;
        }
    }

    applyForce(f: vec3): void {
        vec3.add(this.force, this.force, f);
    }

    applyGravity(): void {
        this.force[1] -= this.mass * this.gravityAcce;
    }

    integrate(deltaTime: number): void {
        if (this.isFixed) return;

        this.applyGravity();

        const a = vec3.create();
        vec3.scale(a, this.force, 1.0 / this.mass);
        
        const accelLength = vec3.length(a);
        if (accelLength > EPSILON) {
            const deltaV = vec3.create();
            vec3.scale(deltaV, a, deltaTime);
            vec3.add(this.velocity, this.velocity, deltaV);
            
            if (vec3.length(this.velocity) < EPSILON) {
                vec3.zero(this.velocity);
            }
            
            const deltaP = vec3.create();
            vec3.scale(deltaP, this.velocity, deltaTime);
            
            // Continuous collision detection: check if movement would cause penetration
            const newPos = vec3.create();
            vec3.add(newPos, this.position, deltaP);
            
            // Check collision before moving to prevent penetration
            if (this.sphereCenter && this.sphereRadius !== null) {
                const margin = this.getSphereCollisionMargin();
                const toNewPos = vec3.create();
                vec3.sub(toNewPos, newPos, this.sphereCenter);
                const newDistance = vec3.length(toNewPos);
                
                if (newDistance < this.sphereRadius + margin) {
                    // Clamp movement to prevent penetration
                    vec3.normalize(toNewPos, toNewPos);
                    vec3.scaleAndAdd(newPos, this.sphereCenter, toNewPos, this.sphereRadius + margin);
                    
                    // Update deltaP to the clamped movement
                    vec3.sub(deltaP, newPos, this.position);
                    
                    // Remove velocity component pointing into the sphere (no extra push-away —
                    // that would inject energy every time gravity re-presses the particle against
                    // the surface, letting the cloth pick up speed indefinitely and slide away).
                    const normal = vec3.clone(toNewPos);
                    const velDotNormal = vec3.dot(this.velocity, normal);
                    if (velDotNormal < 0) {
                        const correction = vec3.create();
                        vec3.scale(correction, normal, velDotNormal);
                        vec3.sub(this.velocity, this.velocity, correction);
                    }
                }
            }

            // Floor plane (also when a sphere collider is present)
            if (newPos[1] < this.groundPos + BASE_COLLISION_MARGIN) {
                newPos[1] = this.groundPos + BASE_COLLISION_MARGIN;
                vec3.sub(deltaP, newPos, this.position);
                if (this.velocity[1] < 0) {
                    this.velocity[1] = 0.0;
                }
            }
            
            vec3.add(this.position, this.position, deltaP);
            
            vec3.copy(this.prevForce, this.force);
        }
        
        vec3.zero(this.force);
    }

    resetForce(): void {
        vec3.zero(this.force);
    }

    getVelocity(): vec3 {
        return this.velocity;
    }

    getPosition(): vec3 {
        return this.position;
    }

    // Strong projection to keep particle outside sphere after integration
    enforceSphereContact(): void {
        if (this.sphereCenter && this.sphereRadius !== null) {
            const margin = this.getSphereCollisionMargin();
            const toParticle = vec3.create();
            vec3.sub(toParticle, this.position, this.sphereCenter);
            let distance = vec3.length(toParticle);
            const targetDist = this.sphereRadius + margin;
            if (distance < targetDist) {
                if (distance < EPSILON) {
                    vec3.set(toParticle, 0, 1, 0);
                    distance = 1.0;
                } else {
                    vec3.scale(toParticle, toParticle, 1.0 / distance);
                }
                vec3.scaleAndAdd(this.position, this.sphereCenter, toParticle, targetDist);

                // Remove any velocity component toward sphere center
                const velDotNormal = vec3.dot(this.velocity, toParticle);
                if (velDotNormal < 0) {
                    const correction = vec3.create();
                    vec3.scale(correction, toParticle, velDotNormal);
                    vec3.sub(this.velocity, this.velocity, correction);
                }
            }
        }
    }

    resetNormal(): void {
        vec3.zero(this.normal);
    }

    addNormal(n: vec3): void {
        vec3.add(this.normal, this.normal, n);
    }

    groundCollision(): void {
        if (this.sphereCenter && this.sphereRadius !== null) {
            // Sphere collision - safety net for any particles that still penetrate
            const margin = this.getSphereCollisionMargin();
            const toParticle = vec3.create();
            vec3.sub(toParticle, this.position, this.sphereCenter);
            const distance = vec3.length(toParticle);
            
            if (distance < this.sphereRadius + margin) {
                // Push particle to sphere surface with margin
                if (distance < EPSILON) {
                    // Handle case where particle is at sphere center (shouldn't happen, but safety)
                    vec3.set(toParticle, 0, 1, 0);
                } else {
                    vec3.normalize(toParticle, toParticle);
                }
                vec3.scaleAndAdd(this.position, this.sphereCenter, toParticle, this.sphereRadius + margin);
                
                // Remove velocity component toward sphere center (no push-away — see integrate()).
                const normal = vec3.clone(toParticle);
                const velDotNormal = vec3.dot(this.velocity, normal);
                if (velDotNormal < 0) {
                    const correction = vec3.create();
                    vec3.scale(correction, normal, velDotNormal);
                    vec3.sub(this.velocity, this.velocity, correction);
                }
                // Friction: bleed off in-surface sliding so cloth settles on the sphere
                // instead of gliding off it forever.
                this.applyContactFriction(normal);
            }
        }

        // Floor plane — always applied (works together with the sphere)
        if (this.position[1] < this.groundPos + BASE_COLLISION_MARGIN) {
            this.position[1] = this.groundPos + BASE_COLLISION_MARGIN;
            if (this.velocity[1] < 0) {
                this.velocity[1] = 0.0;
            }
            this.applyContactFriction(FLOOR_NORMAL);
        }
    }

    /** Damp the velocity component tangential to a contact surface (Coulomb-ish friction). */
    private applyContactFriction(normal: vec3): void {
        const vDotN = vec3.dot(this.velocity, normal);
        const normalVel = vec3.create();
        vec3.scale(normalVel, normal, vDotN);
        const tangentVel = vec3.create();
        vec3.sub(tangentVel, this.velocity, normalVel);
        vec3.scale(tangentVel, tangentVel, this.contactFrictionRetain);
        vec3.add(this.velocity, normalVel, tangentVel);
    }

    /**
     * Set contact grip in [0, 2] (higher = less sliding). Internally stored as
     * tangential velocity retain = max(0, 1 − grip × 0.95).
     */
    setContactFriction(friction: number): void {
        const g = Math.min(2, Math.max(0, friction));
        this.contactFrictionRetain = Math.max(0, 1 - g * 0.95);
    }

    getContactFrictionRetain(): number {
        return this.contactFrictionRetain;
    }
    
    setSphereCollision(center: vec3, radius: number): void {
        this.sphereCenter = center;
        this.sphereRadius = radius;
    }
    
    clearSphereCollision(): void {
        this.sphereCenter = null;
        this.sphereRadius = null;
    }
    
    setEdgeLength(length: number): void {
        this.edgeLength = length;
    }
    
    // Calculate adaptive collision margin based on edge length
    // This ensures that when two adjacent vertices are on the collision surface,
    // the midpoint of the edge between them is also outside the sphere
    private getSphereCollisionMargin(): number {
        if (this.sphereRadius === null || this.edgeLength <= 0) {
            return BASE_COLLISION_MARGIN;
        }
        
        const r = this.sphereRadius;
        const d = this.edgeLength;
        
        // For a chord of length d with vertices at radius R from center,
        // the midpoint is at distance sqrt(R² - (d/2)²) from center.
        // To keep midpoint at least at radius r, we need:
        // margin = sqrt(r² + (d/2)²) - r
        const halfEdge = d / 2;
        const margin = Math.sqrt(r * r + halfEdge * halfEdge) - r;
        
        // Add a small base margin and ensure minimum
        return Math.max(margin + 0.01, BASE_COLLISION_MARGIN);
    }

    setFixed(fixed: boolean): void {
        this.isFixed = fixed;
    }

    isFixedParticle(): boolean {
        return this.isFixed;
    }

    setMass(mass: number): void {
        this.mass = mass;
    }

    getInvMass(): number {
        return this.mass > EPSILON ? 1 / this.mass : 0;
    }

    clampSpeed(maxSpeed: number): void {
        if (!(maxSpeed > 0) || this.isFixed) return;
        const sp = vec3.length(this.velocity);
        if (sp > maxSpeed) {
            vec3.scale(this.velocity, this.velocity, maxSpeed / sp);
        }
    }

    scaleVelocity(factor: number): void {
        if (this.isFixed) return;
        vec3.scale(this.velocity, this.velocity, factor);
    }

    setGravityAcce(gravity: number): void {
        this.gravityAcce = gravity;
    }

    setGroundPos(groundPos: number): void {
        this.groundPos = groundPos;
    }
}

