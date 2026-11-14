# ROCO wire protocol v2 (draft)

**Status: design approved 2026-11-14; nothing in ROCO implements it yet.** Commands, flags, messages and limits marked
*proposed* are the agreed design, and they can still change as they are built and measured. Section 9 records the
decisions. Line references point at ROCO v0.1.3 (commit f90d45e).

Protocol v2 adds a generic topic channel, so the page can show any robot's topics, not only the Unitree G1's. Its shape
follows Foxglove's open ws-protocol v1: the bridge advertises channels, the page subscribes, and binary frames carry a
subscription id and a timestamp. `fetchAsset` serves model files. Everything v1 sends today stays byte for byte the
same, on the same port.

## 1. What v1 does today (unchanged by v2)

| v1 fact | Where |
|---|---|
| The bridge is read-only: no DDS writer can be created in the process, and frames from the page are ignored except replay controls | [roco_dds_bridge.py:8-10](../scripts/roco_dds_bridge.py#L8-L10); the guard is `install_no_publisher_guard`, [line 166](../scripts/roco_dds_bridge.py#L166) |
| The page's messages: only `{"type":"replay_control"}` is used (in replay); anything else is counted and ignored, with "ignoring dashboard commands: this bridge is read-only" printed once | `on_message`, [roco_dds_bridge.py:2061-2072](../scripts/roco_dds_bridge.py#L2061-L2072) |
| Binary frame: a 2092-byte `LowState_` in ROCO's C layout, pelvis xyz in `reserve[0..2]`, sent whenever a new `rt/lowstate` sample arrived | [roco_dds_bridge.py:13-15](../scripts/roco_dds_bridge.py#L13-L15); `_CDR_LS_LEN = 2092`, [line 211](../scripts/roco_dds_bridge.py#L211); `pack_roco_frame`, [line 336](../scripts/roco_dds_bridge.py#L336) |
| Frame layout: a 72-byte head `struct.Struct("<2I2B2xI4f3f3f3fh2x")` at offset 0, then 56-byte motor records; the tick is a u32 at offset 12 | [roco_dds_bridge.py:299-300](../scripts/roco_dds_bridge.py#L299-L300); `OFFSET_TICK = 12`, [roco_common.py:39](../scripts/roco_common.py#L39) |
| Text messages: `hello` on connect, `aux` every frame, `fsm` on change, `replay` (replay only) | [roco_dds_bridge.py:16-19](../scripts/roco_dds_bridge.py#L16-L19) |
| `timeline` (the controller states of a replay) | [roco_dds_bridge.py:1555](../scripts/roco_dds_bridge.py#L1555) |
| `hello` already carries `"protocol": 1` and `"readOnly": True`, plus a session id and start time | `build_hello`, [roco_dds_bridge.py:2170-2186](../scripts/roco_dds_bridge.py#L2170-L2186) |
| Port 8765 by default | [roco_dds_bridge.py:2939](../scripts/roco_dds_bridge.py#L2939) |
| Access: the `AccessPolicy` Origin allow-list and optional token; `--allow-origin` and `--token` / `ROCO_BRIDGE_TOKEN`; a non-loopback `--host` needs a token | [roco_common.py:229](../scripts/roco_common.py#L229); [roco_dds_bridge.py:2943-2944](../scripts/roco_dds_bridge.py#L2943-L2944), [2956-2957](../scripts/roco_dds_bridge.py#L2956-L2957) |
| Page → bridge messages are at most 4096 bytes; a larger one closes the socket with 1009 | `MAX_MESSAGE_BYTES`, [roco_common.py:217](../scripts/roco_common.py#L217); [line 443](../scripts/roco_common.py#L443) |
| At most 8 clients | `MAX_CLIENTS`, [roco_common.py:218](../scripts/roco_common.py#L218) |
| A client whose oldest unsent frame is over 1 s old while its socket is full is disconnected, not given gaps | `MAX_CLIENT_LAG_S`, [roco_common.py:222](../scripts/roco_common.py#L222), checked at [line 328](../scripts/roco_common.py#L328) |

v2 keeps all of this. A v1 page (one that never sends the v2 `hello` below) gets exactly today's stream.

## 2. Version negotiation (proposed)

1. On connect the bridge sends today's `hello` unchanged, with one added field: `"protocols": [1, 2]`. `"protocol": 1`
   stays, because the session report prints it ([sessionReport.ts:138](../src/utils/sessionReport.ts#L138)).
2. A v2 page sends `{"type": "hello", "protocol": 2}` only if the bridge's `hello` lists 2. Against a v0.1.x bridge (no
   `protocols` field) the page stays on v1 and shows the G1 only.
3. The bridge answers `{"type": "welcome", "protocol": 2, "limits": {...}}` (the limits of section 6), then sends
   `advertise` with every channel it knows.
4. A page asking for a version the bridge does not have gets `error` `unsupported_protocol` and stays on v1.

| Page | Bridge | Result |
|---|---|---|
| v1 (today) | v2 | today's stream, unchanged |
| v2 | v0.1.x | v1: G1 frames and the v1 text messages |
| v2 | v2 | v2 after the handshake |

After the handshake, every binary frame to that client is one of the two framed kinds in section 4. The G1 frame is
then delivered inside a batch on the reserved subscription id 0, still 2092 bytes and in the same layout. This way a
v2 page never has to guess a frame's kind from its length. The v1 text messages (`aux`, `fsm`, `replay`, `timeline`)
keep coming as they do today.

## 3. Channels and subscriptions (proposed)

**`advertise`** (bridge → page), on welcome and whenever a topic appears:

```json
{"type": "advertise", "channels": [
  {"id": 7, "topic": "/joint_states", "type": "sensor_msgs/msg/JointState", "encoding": "cdr",
   "schemaEncoding": "ros2msg", "schema": "<the message definition text>",
   "rateHz": 50.0, "qos": {"reliability": "reliable", "durability": "volatile"}}
]}
```

- `id` is the bridge's channel id, a u32, never reused while the bridge runs.
- `schema` is the full definition text, so the page can decode CDR without a type database.
- `rateHz` is measured over the last few seconds; it is refreshed in `stats`.

**`unadvertise`** (bridge → page): `{"type": "unadvertise", "ids": [7]}` when the topic's last publisher has gone.
Silence alone never removes a topic, because a topic sent once, such as a robot description, would otherwise vanish.
Subscriptions to it are kept and resume when it comes back.
- **Native path:** the reader's subscription-matched status reports `current_count` 0 (cyclonedds 0.10.2,
  `Listener.on_subscription_matched`).
- **rclpy path:** Humble's rclpy has no matched event, so the bridge polls `Node.count_publishers` once a second.

**`subscribe`** (page → bridge):

```json
{"type": "subscribe", "subscriptions": [{"id": 1, "channel": 7, "maxHz": 50}]}
```

- The page picks the subscription `id`: a u32 from 1 up. 0 is reserved for the G1 frame.
- `maxHz` is from 0.1 to 1000 and defaults to 50, the v1 frame rate. The bridge forwards a sample only when at least
  1/`maxHz` has passed since the last sample it forwarded on that subscription. It drops the others and counts them in
  `stats`.
- Every subscribe must fit in 4096 bytes (section 1), which is roomy for 64 entries.

**`unsubscribe`** (page → bridge): `{"type": "unsubscribe", "ids": [1]}`.

**`stats`** (bridge → page), once a second: for each channel its `rateHz`, and for each subscription the counts of
`forwarded`, `droppedByRate` and `oversize`. The page shows these, so a dropped sample is never silent.

## 4. Binary frames (proposed)

All numbers are little-endian. Each frame starts with a 4-byte ASCII tag.

**Batch** (`RCB2`), the data path:

```
"RCB2"  u32 record count
then per record:
  u32 payload length   u32 subscription id   u64 receive time, ns since the Unix epoch (bridge clock)   payload
```

- A record header is 16 bytes. Records are not padded; CDR alignment is relative to the payload start, so the page
  decodes each payload as its own view.
- A batch carries every record queued for that client since the last flush. The bridge flushes as soon as the client's
  socket can take more, and at the latest after 20 ms or 256 KB.
- The payload is the sample exactly as received (CDR for DDS and ROS 2, the 2092-byte frame for id 0). The bridge
  decodes nothing on the hot path.

**Why batching is required.** Spike S1 (2026-11-14) sent one WebSocket frame per message at 2000 messages/s and about
1.5 MB/s. With two clients, the bridge fell behind and disconnected the slower one, which was 7.8 s behind. Batching
fixed it: batches averaged 1.6–1.7 messages, and nothing was dropped. S1's record was
`[u32 CDR length][u16 topic id][u64 recv ns][CDR]`. v2 widens the id to a u32 subscription id, the Foxglove shape.

**Asset chunk** (`RCA2`), the reply data of `fetchAsset`:

```
"RCA2"  u32 request id  u64 offset  bytes (at most 256 KB)
```

## 5. `fetchAsset` (proposed)

This message lets the page load meshes and textures of a model the bridge can see on disk: a ROS package, or a folder
given with `--model-dir`.

```json
{"type": "fetchAsset", "requestId": 12, "uri": "package://ur_description/meshes/ur5e/visual/base.dae"}
```

The bridge answers `{"type": "asset", "requestId": 12, "ok": true, "size": 123456, "sha256": "..."}`, then sends
`RCA2` chunks in order. On failure it sends `error` with the `requestId`.

**Path rules.** These are the importer's rules (stage 1.1). The page's zip and folder import uses the same ones.
- `package://name/rest` resolves only to a package the bridge found (the ament index, or a `package.xml` under a
  `--model-dir`). A plain relative path resolves against a `--model-dir`.
- Refused:
  - `file://` and absolute paths;
  - any `..` segment;
  - symlinks that resolve outside their root;
  - anything that is not a regular file.
- An extension allow-list: urdf, xacro, xml, sdf, mjcf, stl, dae, obj, mtl, gltf, glb, bin, png, jpg, jpeg, ktx2.
  USD is not served. A USD robot goes through `roco usd2gltf` (D8), because the page has no reader for its UsdPhysics
  joints. three.js 0.187's `USDLoader` reads meshes and skeletons, but not UsdPhysics.
- At most 64 MB per file and 512 MB per model, matching spike S6's proposed import limit.
- At most 4 requests in flight per client.

Serving files makes local data reachable from the page, so `fetchAsset` obeys the same `AccessPolicy` as the socket
(section 1). Only the roots above are served.

## 6. Limits and errors (proposed)

| Limit | Value | Basis |
|---|---|---|
| Page → bridge message | 4096 bytes (unchanged) | `MAX_MESSAGE_BYTES`, roco_common.py:217 |
| Clients | 8 (unchanged) | `MAX_CLIENTS`, roco_common.py:218 |
| Subscriptions per client | 64 | proposed |
| Forwarded per client | 4000 messages/s and 4 MB/s, summed over its subscriptions. Fixed, with no flag; the byte cap is provisional (below) | twice S1's load (2000 messages/s, 1.5 MB/s) |
| One record's payload | 16 MB; larger samples are counted as `oversize` and not sent | proposed (camera images and point clouds) |
| Slow client | disconnected at 1 s behind (unchanged) | `MAX_CLIENT_LAG_S`, roco_common.py:222 |
| Asset | 64 MB per file, 512 MB per model, 4 in flight | S6 proposed limits |

A subscribe that would cross a per-client rate cap is refused with `rate_limit`; nothing already flowing is cut. The
page can lower `maxHz` and try again.

**Provisional byte cap.** S1 measured small messages only. One raw 640×480 `rgb8` image is 921 600 bytes, so 4 MB/s
allows about 4 such images a second. Stage 1.3 adds throttled image preview and point clouds. It measures those before
the byte cap is frozen.

**Measured cost at the caps.**
- S1, native cyclonedds 0.10.2 bridge, 2000 messages/s: 15% of one core with no clients, 28% with two. Latency from
  stamp to client was p50 0.2 ms and p99 about 0.4 ms.
- The rclpy `raw=True` path cost 107–114% of a core for the same load; that is rclpy itself, about 0.5 ms per message.
- Page worker decode: about 17–18 µs per JointState and 4 µs per Imu. 4000 JointState messages/s is therefore about 7%
  of the worker.
- The scratch page's memory grew about 70 MB in 30 s, so the real page must bound its buffers.

**Errors** (bridge → page): `{"type": "error", "code": "...", "message": "...", "requestId": 12}`. `requestId` is present
only for `fetchAsset`.

| Code | When |
|---|---|
| `bad_request` | not JSON, or a field is missing or of the wrong type |
| `unknown_type` | a `type` the bridge does not handle (this includes any attempt to publish; see section 7) |
| `unsupported_protocol` | the `hello` asks for a version the bridge lacks |
| `unknown_channel` | subscribe to a channel id never advertised |
| `duplicate_subscription` | a subscription id already in use on this client |
| `too_many_subscriptions` | over 64 |
| `rate_limit` | `maxHz` out of range, or the per-client caps |
| `not_found` | `fetchAsset`: no such package or file |
| `forbidden_path` | `fetchAsset`: breaks a path rule |
| `too_large` | `fetchAsset`: over the size limits |
| `busy` | `fetchAsset`: 4 requests already in flight |

The close codes stay as they are today; for example, 1009 is still sent for an inbound message over 4096 bytes.

## 7. Read-only guarantee

**Protocol v2 has no operation that writes to the robot.**
- The page may send only five messages:
  - `hello`;
  - `subscribe`;
  - `unsubscribe`;
  - `fetchAsset`;
  - `replay_control` (v1, replay only).
- There is no publish, no service call, no parameter set and no action goal.
- Any other `type` is answered with `unknown_type` on v2. On v1 it is ignored, as today.

The bridge cannot write even if asked:
- **v1 and the native DDS path:** they keep `install_no_publisher_guard` ([roco_dds_bridge.py:166](../scripts/roco_dds_bridge.py#L166)),
  which makes every way of creating a DDS writer raise.
- **The rclpy path (proposed):**
  - Its node is created with `enable_rosout=False` and `start_parameter_services=False`. Both are keyword arguments of
    rclpy's `Node` on Humble (`rclpy/node.py` lines 124–125). So the node has no `/rosout` writer and serves no
    parameter services.
  - A guard makes `create_publisher`, `create_client`, `create_service` and action clients raise.
  - Its self-test checks that each one raises.

DDS discovery's built-in endpoints still exist, as they do in v1. They carry discovery data only, never samples.

## 8. Commands and flags (all proposed)

| Proposal | What it does | Stage |
|---|---|---|
| `roco ros2 [--domain N] [--topics GLOB ...] [--path native\|rclpy] [--model-dir DIR ...] [--port P] [--web-port P] [--open]` | Read-only ROS 2 monitor over protocol v2. **Default `native`** (decided 2026-11-14): cyclonedds 0.10.x reads ROS 2 topics as `rt/<name>`, which cost 15–28% in S1. It falls back to `rclpy` (107–114%) where the RMW does not speak DDS on the network: rmw_zenoh, shared-memory-only Fast DDS, or a discovery server. | 1.4 |
| `roco doctor [--json]` | Prints checks and changes nothing. See the list below. | 1.4 |
| `--model-dir DIR` on `sim`, `robot`, `replay` and `ros2` | A root for `fetchAsset` (section 5). | 1.4 |
| `roco record --format mcap\|csv` | New recordings in MCAP (D14), with CSV still available. v1 CSV recordings still play. | 1.5 |
| `roco usd2gltf IN OUT` | Converts a USD robot to glTF plus a joints file, for the page. Needs the optional `roco[usd]` (D8). | 1.6 |

`roco doctor` checks:
- the Python version and whether the `dds` extra is importable;
- which `libddsc` is loaded. S1 found two identical copies, one of them in user site-packages, and plain `python3`
  loads that one first;
- `ROS_DOMAIN_ID`, `RMW_IMPLEMENTATION` and `ROS_LOCALHOST_ONLY`, and whether `CYCLONEDDS_URI` selects `lo` while
  `ROS_LOCALHOST_ONLY=1`. On Humble, that pair stops the Cyclone RMW with "lo: the same interface may not be selected
  twice" (S1);
- which cyclonedds version would meet which on `lo`. 11.x sends discovery only to multicast there and 0.10.x uses
  unicast, so by default they never see each other. When 11.1.0 was made to find a 0.10.x simulator, it crashed the
  simulator (S2). The native path therefore stays on 0.10.x (D9);
- whether ports 8765 and the page port are free, and what holds them. A clash with foxglove_bridge is named (D6);
- the network interfaces.

The existing commands (`sim`, `robot`, `replay`, `demo`, `record`) keep their flags and behaviour.

## 9. Decisions (2026-11-14)

1. **The G1 frame on v2 pages:** it uses the reserved subscription id 0 and is not an ordinary channel. The frame is
   built by the bridge from lowstate plus odometry (`pack_roco_frame`), not forwarded from one topic, and v1's path stays
   untouched.
2. **When a topic goes:** when its last publisher has gone, not after a silence (section 3).
3. **Per-client caps:** fixed, with no flag. The byte cap is re-measured in stage 1.3 before it is frozen (section 6).
4. **USD:** not served by `fetchAsset`; it goes through `roco usd2gltf` (section 5).
5. **`roco ros2` path:** native cyclonedds by default, with rclpy as the fallback where DDS is not on the network
   (section 8).
