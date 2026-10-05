# Floq / Carpooling System 🚗

A real-time ride-matching platform built for dynamic carpooling. 

## UI Showcase
<div align="center">
  <img src="screenshots/login.png" alt="Login Screen" width="45%" />
  <img src="screenshots/home.png" alt="Ride Request Screen" width="45%" />
  <br />
  <img src="screenshots/match.png" alt="Trip Screen" width="45%" />
  <img src="screenshots/complete.png" alt="Summary Screen" width="45%" />
</div>

## The Problem It Solves
Traditional ride-hailing pairs one driver with one rider. Floq dynamically clusters multiple riders heading in the same general direction and optimizes their pickup/drop-off sequence. It ensures that no passenger experiences an unacceptable detour while maximizing driver earnings and vehicle capacity.

## Architecture

```mermaid
graph TD
    subgraph Clients
        RiderApp[Rider Client - Vite/React]
        DriverApp[Driver Client - Vite/React]
    end

    subgraph Backend Server Node.js / Express
        API[API Router]
        Socket[Socket.io Server]
        
        subgraph Modules
            Auth[Auth Service]
            RideReq[Ride Request Service]
            Trip[Trip Service]
            Driver[Driver Service]
            Matching[Matching Engine]
            Scheduler[Cron Scheduler]
        end
        
        subgraph Utilities
            Cache[Redis Cache]
            Lock[Distributed Lock]
            RateLimiter[Rate Limiter]
        end
    end

    subgraph Databases
        Postgres[(PostgreSQL)]
        Redis[(Redis)]
    end

    RiderApp <--> |REST / WS| API
    DriverApp <--> |REST / WS| API
    RiderApp <--> |WS| Socket
    DriverApp <--> |WS| Socket
    
    API --> Modules
    Socket --> Trip
    Socket --> Driver
    Scheduler --> Matching
    
    Modules --> Cache
    Modules --> Postgres
    Matching --> Lock
    Cache --> Redis
    Lock --> Redis
    RateLimiter --> Redis
```

## Key Engineering Decisions

1. **Concurrency Control in Ride Matching (Preventing Double-Matches)**
   Ride matching is triggered via a cron job every 45 seconds. To prevent race conditions if multiple server instances are running, the system employs a two-layer defense:
   - **Distributed Locking:** Uses a Redis `SET NX PX` lock (`matching:cron:lock` with a 5-minute TTL) to ensure only one instance executes the matching logic. Lua scripts handle atomic check-and-delete during release.
   - **Row-Level DB Locks:** The matcher fetches pending ride requests using PostgreSQL's `FOR UPDATE SKIP LOCKED`. This guarantees that if a transaction is processing a set of requests, other concurrent queries will skip them rather than blocking or reading dirty data.

2. **Route Sequence Optimization & Detour Limits**
   When grouping 2-4 users, the system calculates all valid pickup/drop-off permutations (using backtracking to ensure pickups always precede drop-offs). It evaluates each sequence's total distance. Crucially, it calculates the **detour ratio** for *every individual user* in the sequence. If any user's detour exceeds `MAX_USER_DETOUR` (30%), the entire grouping is rejected, ensuring fairness.

3. **Real-Time Location via Redis Cache-Aside & Socket.io**
   High-frequency driver GPS updates are pushed via WebSockets (`driverLocationUpdate`). Instead of hammering the database, the server persists the latest coordinates in Redis (`driver:location:{tripId}`) with a 60-second TTL. When new riders join the trip room (`joinTrip`), they immediately receive the cached location for an instant map pin, rather than waiting for the driver's next GPS tick.

4. **Multi-Tier Rate Limiting**
   Implemented a fixed-window rate limiter using Redis `INCR` and `EXPIRE`. It is applied differentially:
   - **Auth Routes:** Strict limit (10 req / 15 min per IP) to prevent brute-force attacks on login, registration, and OTP endpoints.
   - **API Routes:** Relaxed limit (100 req / 1 min per authenticated `userId`) to prevent abuse while accommodating normal usage. The middleware is designed to fail open if Redis goes down, ensuring the API remains available.

5. **OSRM Routing with Haversine Fallback**
   To calculate accurate fare and ETA, the system queries the OSRM (Open Source Routing Machine) API for real-world road distances. Because network calls can fail, the system includes a reliable fallback: it calculates the Haversine (straight-line) distance and multiplies it by a tested `ROAD_TO_HAVERSINE_CORRECTION` factor (1.35) to estimate the road distance without stalling the request.

## Load Testing
A `k6` load testing script is configured to simulate high-concurrency ride request creation and matching. 

To run the scenario locally:
```bash
k6 run server/load-tests/matching-scenario.js
```

| Metric | Target | Actual |
|--------|--------|--------|
| Concurrent Users | 50 | *Pending run* |
| Request Duration (p95) | < 500ms | *Pending run* |
| Error Rate | < 1% | *Pending run* |

## Tech Stack

| Category | Technologies |
|----------|-------------|
| **Frontend** | React 19, Vite 8, Tailwind CSS v4 |
| **Backend** | Node.js, Express.js |
| **Real-Time** | Socket.io |
| **Database & ORM** | PostgreSQL, Prisma (`@prisma/client`) |
| **Caching & Locks** | Redis (`ioredis`) |
| **Routing / Maps** | OSRM API |
| **Background Jobs** | `node-cron` |

## Testing
The repository includes test suites covering route optimization, cancellation logic, Redis integration phases (OTP, auth, caching, rate limiting, locking), and Razorpay payment flows.

```bash
cd server
npm test              # run all tests (requires Postgres + Redis)
npm run test:unit     # run unit tests only (no external services)
```

- **CI:** GitHub Actions runs unit tests on every push and integration tests against Postgres 16 + Redis 7 service containers.
- **Coverage:** Unit and integration tests verify cache invalidation, Redis TTL auto-expiry, transaction integrity during cascade cancellations, and matching constraints.

*Integration tests require a local PostgreSQL and Redis instance.*

## Setup Instructions

1. **Clone and Install:**
   ```bash
   git clone https://github.com/manav-bhullar/floq.git
   cd floq/server
   npm install
   ```

2. **Environment Variables (`server/.env`):**
   ```env
   DATABASE_URL="postgresql://user:pass@localhost:5432/carpool_db"
   REDIS_URL="redis://localhost:6379"
   PORT=5050
   JWT_SECRET=your_secret
   JWT_REFRESH_SECRET=your_refresh_secret
   EMAILJS_SERVICE_ID=your_service_id
   EMAILJS_TEMPLATE_ID=your_template_id
   EMAILJS_PUBLIC_KEY=your_public_key
   EMAILJS_PRIVATE_KEY=your_private_key
   RAZORPAY_KEY_ID=your_key_id
   RAZORPAY_KEY_SECRET=your_key_secret
   FRONTEND_URL=http://localhost:5173
   ```

3. **Database Setup:**
   ```bash
   npx prisma generate
   npx prisma db push
   ```

4. **Start the Server:**
   ```bash
   npm run dev
   ```

## Known Limitations / What I'd Improve Next
- **Matching Engine Scaling:** Currently, the matching engine pulls pending requests in batches. If the pending pool grows massively, scoring every possible pair $O(n^2)$ will bottleneck. Next step: Implement PostGIS or Redis geospatial indexing to only score pairs within a 5km radius.
- **Driver Rejection Handling:** The `DriverTrip` model supports a `CANCELLED` state, but there isn't a robust mechanism to rapidly re-queue a `RIDERS_MATCHED` trip to a different driver if the first driver rejects it, leading to potential auto-expiry.

## Lifecycle Updates

The rider client fetches its current state on mount and refreshes it on private `trip_updated` and `ride_request_updated` socket events. It also refreshes on reconnect and when the tab regains focus. Matching, expansion, cancellation/requeue, driver acceptance, start, completion, and expiry publish events after database commit and cache invalidation. Lifecycle state is updated atomically; completed trips stay available for the summary screen. Periodic ride/trip polling has been removed.

## Render Deployment

The root `render.yaml` provisions the Express backend, PostgreSQL, and Redis-compatible Render Key Value. The frontend stays on Vercel. Configure the prompted frontend URL, EmailJS, and Razorpay values in Render, then set Vercel `VITE_API_URL` to the backend URL followed by `/api`.

The blueprint uses paid, always-on services for the matching scheduler. It generates JWT secrets and keeps both datastores private. The pre-deploy command uses `prisma db push` because the checked-in migrations do not yet cover the current schema; establish a complete migration baseline before using this blueprint for an existing database. No deployment has been performed.
