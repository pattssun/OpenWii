# fruit-ninja — rebuild spec

> A web-based Fruit Ninja clone that uses a smartphone as a wireless motion controller.

_Reverse-engineered from a demo video (https://www.instagram.com/reel/DZiAyThpC63/). Un-vetted: treat as a starting point, not ground truth._

## What it does

This project transforms a standard smartphone into a motion-sensing controller (similar to a Nintendo Wii remote) to play a desktop game. It reads the phone's internal IMU (accelerometer/gyroscope) data and streams it over a local network to a PC. The PC client translates these 3D physical movements into 2D screen coordinates to slice virtual fruit in real-time.
## User flow

- User launches the local server and opens the game interface on their PC.
- User opens a companion web app on their smartphone and connects it to the PC server via local IP.
- User physically swings the smartphone in the air.
- The PC screen shows a slicing trail corresponding to the phone's movement.
- Fruits are sliced when the on-screen trail intersects them.
## Key features

- Real-time sensor data extraction (DeviceMotion/DeviceOrientation).
- Low-latency wireless communication between devices.
- Algorithm to map 3D rotational/acceleration data to 2D screen coordinates.
- Game engine logic for object spawning, gravity physics, and line-intersection collision detection.
## Inferred stack

- **frontend:** HTML5 Canvas or Phaser.js (for the PC game), Vanilla JS / HTML (for the phone sensor client)
- **backend:** Node.js with Express and Socket.io (local network relay)
- **models_or_ai:** Signal processing (Simple Moving Average or Kalman filter for sensor smoothing)
- **apis_or_services:** Web APIs: DeviceOrientationEvent and DeviceMotionEvent
- **storage:** None required (in-memory game state)
- **infra:** Local Area Network (LAN)
## Architecture

A lightweight Node.js server acts as a WebSocket relay on the local network. The smartphone connects as a 'controller client' sending high-frequency IMU telemetry. The PC connects as a 'game client', listening for telemetry, mapping the raw data to an absolute or relative X/Y coordinate, and rendering the game loop.
## Data flow

Smartphone IMU Sensor -> Phone Web App -> WebSockets (LAN) -> Node.js Server -> WebSockets (LAN) -> PC Game Client -> Coordinate Mapping -> Render Slicing Trail & Trigger Collision.
## Notable details

- Extremely low latency, suggesting a direct local network WebSocket connection rather than a cloud-hosted relay.
- The slicing trail indicates continuous coordinate tracking rather than discrete gesture recognition (it maps real-time position, not just a 'swipe left' command).
## Unknowns / your calls to make

- Whether the phone app is a native application or a web browser accessing the DeviceOrientation API.
- The exact mathematical mapping used to anchor the phone's resting state to the center of the screen (calibration method).
- Whether it uses absolute positioning (pointing like a laser pointer) or relative positioning (mouse-like delta movement).
