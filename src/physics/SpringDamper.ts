import { vec3 } from 'gl-matrix';
import { Particle } from './Particle';

const EPSILON = 1e-6;

export class SpringDamper {
    private springConst: number;
    private dampingConst: number;
    private restLength: number;
    private p1: Particle;
    private p2: Particle;
    private prevDir: vec3;

    constructor(
        p1: Particle,
        p2: Particle,
        springConst: number,
        dampingConst: number,
        restLength: number
    ) {
        this.p1 = p1;
        this.p2 = p2;
        this.springConst = springConst;
        this.dampingConst = dampingConst;
        this.restLength = restLength;
        
        const dir = vec3.create();
        vec3.sub(dir, p2.getPosition(), p1.getPosition());
        this.prevDir = dir;
    }

    computeForce(): void {
        const dir = vec3.create();
        vec3.sub(dir, this.p2.getPosition(), this.p1.getPosition());
        const currLength = vec3.length(dir);

        if (currLength > EPSILON) {
            vec3.normalize(dir, dir);
            vec3.copy(this.prevDir, dir);
        } else {
            vec3.zero(dir);
        }

        // Spring force: F = -k * (x - l) * dir
        const springForce = vec3.create();
        vec3.scale(springForce, dir, -this.springConst * (this.restLength - currLength));
        
        if (vec3.length(springForce) < EPSILON) {
            vec3.zero(springForce);
        }

        // Damping force: F = -c * v * dir
        const v1 = this.p1.getVelocity();
        const v2 = this.p2.getVelocity();
        const relVel = vec3.create();
        vec3.sub(relVel, v1, v2);
        const v = vec3.dot(relVel, dir);
        
        const damperForce = vec3.create();
        vec3.scale(damperForce, dir, -this.dampingConst * v);
        
        if (vec3.length(damperForce) < EPSILON) {
            vec3.zero(damperForce);
        }

        // Apply forces
        const totalForce = vec3.create();
        vec3.add(totalForce, springForce, damperForce);
        this.p1.applyForce(totalForce);
        
        const oppositeForce = vec3.create();
        vec3.negate(oppositeForce, totalForce);
        this.p2.applyForce(oppositeForce);
    }
    
    setSpringConst(k: number): void {
        this.springConst = k;
    }

    setRestLength(length: number): void {
        this.restLength = Math.max(0, length);
    }
    
    setDampingConst(c: number): void {
        this.dampingConst = c;
    }

    getRestLength(): number {
        return this.restLength;
    }

    /**
     * Provot strain limit: if the edge exceeds rest×maxStretch, pull endpoints
     * back along the current direction (mass-weighted). Compression is allowed.
     */
    enforceMaxStretch(maxStretch: number): void {
        if (!(maxStretch > 1) || this.restLength <= EPSILON) return;
        const maxLen = this.restLength * maxStretch;
        const p1 = this.p1.getPosition();
        const p2 = this.p2.getPosition();
        const dir = vec3.create();
        vec3.sub(dir, p2, p1);
        const len = vec3.length(dir);
        if (len <= maxLen || len < EPSILON) return;

        vec3.scale(dir, dir, 1 / len);
        const correction = len - maxLen;
        const m1 = this.p1.isFixedParticle() ? 0 : this.p1.getInvMass();
        const m2 = this.p2.isFixedParticle() ? 0 : this.p2.getInvMass();
        const wSum = m1 + m2;
        if (wSum < EPSILON) return;

        if (m1 > 0) {
            vec3.scaleAndAdd(p1, p1, dir, correction * (m1 / wSum));
        }
        if (m2 > 0) {
            vec3.scaleAndAdd(p2, p2, dir, -correction * (m2 / wSum));
        }

        // Kill relative velocity along the edge when limiting so the spring
        // doesn't immediately re-overstretch next substep.
        const v1 = this.p1.getVelocity();
        const v2 = this.p2.getVelocity();
        const rel = vec3.create();
        vec3.sub(rel, v1, v2);
        const along = vec3.dot(rel, dir);
        if (along > 0) {
            if (m1 > 0) vec3.scaleAndAdd(v1, v1, dir, -along * (m1 / wSum));
            if (m2 > 0) vec3.scaleAndAdd(v2, v2, dir, along * (m2 / wSum));
        }
    }
}

