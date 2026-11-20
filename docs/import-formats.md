# Importing a robot model

ROCO's page can show a robot other than the built-in G1. Open **Settings › Import model…** and pick a folder, some files or a
zip, or drop them on the 3D view. Everything happens in the browser tab:

- nothing is uploaded and nothing is fetched from the network;
- the files are only read;
- the imported robot lasts until the page is reloaded, and the page keeps the last 3 imports.

ROCO stays read-only with an imported robot, as with the G1. The 3D view moves the robot from the joint angles a ROCO bridge
sends; see [Joints and motors](#joints-and-motors).

## What you can import

| You have | Import it with |
|---|---|
| A ROS package or a robot folder | **Select Robot Folder**, choosing the whole folder |
| A description and its meshes | **Select Model Files**, choosing all of them |
| A zip of either | **Select Model Files**; the zip is unpacked in the tab |

**Description files:**

| Format | Files | How ROCO reads it |
|---|---|---|
| URDF | `.urdf` | as it is |
| xacro | `.xacro` | expanded to URDF the way Python xacro 2.1.1 (the version ROS 2 ships) does |
| MuJoCo MJCF | `.xml` | converted to URDF the way MuJoCo 3.17 compiles it |
| SDFormat 1.4–1.11 | `.sdf`, with its `model.config` | converted to URDF |

**Meshes:** STL (binary and ASCII), COLLADA `.dae`, OBJ, and glTF (`.gltf` and `.glb`). The 3D view draws each link's visual
geometry; collision geometry is not drawn.

### Which file is the robot

When the import holds several description files, ROCO picks one:
1. A `.urdf` file wins.
2. Otherwise it takes a `.xacro` file (or, with no xacro, an `.xml` or `.sdf` file) that no other file includes. An SDF model
   included as `model://<its folder>` counts as included.
3. If more than one is still left, the first is used, and the report says which.

To use another one, import a folder that holds only that description and its files.

### How meshes and includes are found

A robot file can name its meshes and includes in many ways. ROCO looks each one up among the imported files only:

- `package://` and `model://` paths;
- `file://` paths, and absolute paths from the author's PC, matched by the longest shared path ending;
- `$(find pkg)`;
- paths relative to the file that names them.

A file found by anything other than its exact path is reported under **Substituted**, and so is a name that matches several
imported files equally well (one of them is used). A relative path that climbs out of the imported folder is not followed.
A mesh that is not among the imported files is reported, and that part is not drawn.

## Each format in detail

### xacro

The expander follows Python xacro 2.1.1 in its default in-order mode. It supports:

- properties, with scopes, blocks and lazy evaluation;
- `${}` Python expressions: int and float arithmetic, strings, lists, dicts, comprehensions and lambdas. They are evaluated by
  ROCO's own evaluator, never by JavaScript `eval`;
- `$(arg)`, `$(find)`, `$(optenv)`, `$(dirname)` and `$(eval)`;
- macros with defaults, `^` and `^|` forwarding, and `*` and `**` block parameters;
- `xacro:include`, with namespaces;
- `xacro:call`, `xacro:element`, `xacro:attribute`, `xacro:if` and `xacro:unless`;
- `load_yaml`, and the `xacro.` functions.

**Arguments.** When the xacro has arguments, the import dialog lists them with their values. Change them, or fill in the
ones with no value, and press **Import again with these values**.

**Where Python xacro would stop,** ROCO reports the problem and leaves out that element or expression, so one bad line does
not lose the whole robot. These are reported:
- an expression that cannot be evaluated;
- an include that is not among the imported files;
- an argument with no value;
- `$(env)`, since a browser has no environment variables;
- an include with a wildcard in its file name.

`xacro.fatal()` in the file stops the import.

### MuJoCo MJCF

The converter follows MuJoCo 3.17's compiler, checked against `mujoco` itself. It supports:

- `include`;
- default classes and `childclass`;
- `frame`;
- every orientation form (`quat`, `axisangle`, `euler` with `eulerseq`, `xyaxes`, `zaxis`), in degrees or radians;
- `fromto` on capsules, cylinders, boxes and ellipsoids;
- mesh `scale`, `meshdir`, `assetdir`, `strippath` and `autolimits`.

A body with several joints becomes a chain of helper links (`<body>__j2`, …) with one joint each. The view shows geom groups
0–2, as MuJoCo's viewer does; if no geom is in those groups, every group is drawn.

| Approximated | How it is shown |
|---|---|
| Free joint | a floating base |
| Ball joint | fixed |
| Joint `ref` | ignored: the joint reads 0 where MuJoCo reads `ref` |
| Capsule | a cylinder with a sphere on each end |
| Ellipsoid | a sphere of its largest radius |
| Primitive fitted to a mesh | the mesh |
| Textures | the material colour |

**Not supported,** and reported when present:
- tendons and equality constraints (the joints they couple move on their own);
- `composite`, `flexcomp`, `flex`, `skin`, `replicate` and `attach`;
- inline meshes (vertex data in the file), and `hfield` and `sdf` geoms;
- geoms fixed to the world (scenery);
- `coordinate="global"`.

### SDFormat

The converter reads SDFormat 1.4 to 1.11:
- each pose is read against its `relative_to` frame (or, before 1.7, its `frame`), or else its element's default frame;
- `<frame>` elements;
- nested models, flattened with `::` names, as Gazebo names them;
- `<include>` of models from the import.

When a file holds several models, the one with the most joints is used, and the report says so.

Revolute, prismatic, continuous and fixed joints are kept as they are. A universal or revolute2 joint becomes two revolute
joints.

| Approximated | How it is shown |
|---|---|
| Ball and gearbox joints | fixed |
| Screw joint | turning only; its sliding is not shown |
| Links not joined to the rest | fixed where each starts |
| Submesh | the whole mesh |
| Ellipsoid | a sphere of its largest radius |
| Capsule | a cylinder with a sphere on each end |
| Gazebo material scripts | the colour given beside them, or the default |

**Reported problems:**
- a pose that refers to a missing frame, or poses that refer to each other in a loop (the model frame is used);
- a joint that names a missing link, or joints that form a closed loop (one is left out);
- models included from outside the import, such as `model://sun` (not drawn);
- visual shapes other than box, sphere, cylinder, capsule, ellipsoid, mesh and plane, such as a heightmap (not drawn).

### Zip files

A zip is unpacked in a separate worker, one entry at a time, and each entry's checksum is checked. A zip is refused if it:
- is damaged or encrypted;
- uses a compression method other than stored or deflate;
- holds a symbolic link, the same name twice, or a name that points outside its folder (`..`, an absolute path or a drive
  letter).

The size limits are in [Limits](#limits).

## Size, units and up axis

URDF, MJCF and SDF are in metres with Z up. A file made in millimetres loads a thousand times too big, and one made Y-up lies
on its side. When the 3D view finds either, it says what it found and offers **Fix**. Nothing changes until you press it.
COLLADA files carry their own unit and up axis, and those are applied.

A biped's or quadruped's standing height is measured from its meshes.

## Joints and motors

The imported robot's movable joints (revolute, continuous and prismatic) are tied to the motors a ROCO bridge reports:

- **The bridge sends its motor names.** Each joint is matched to the motor with its name. A joint the bridge does not name
  shows no data, and the joint table says how many there are and names the first four.
- **The bridge sends no names.** The joints follow the file's order: the first joint is motor 0. The joint table says
  "Motor order not checked"; check that each joint moves with the right motor.

**Limits on joints:**
- A `LowState_` frame has 35 motor slots. In a robot with more movable joints, the joints after the first 35 show no data
  unless the bridge names them. The report counts them and names up to 10.
- The replay history keeps the first 29 motor slots. A joint on slots 29–34 shows its live value, not its value at the time
  cursor.
- A robot with no movable joints, such as a drone whose rotors are fixed joints, is shown as one rigid body. The report and
  the joint table say so.

## Limits

The files are untrusted, so each limit ends the import with a named reason. None of them can crash or hang the tab.

| What | Limit |
|---|---|
| Zip file | 512 MiB |
| Zip contents, unpacked | 512 MiB in all |
| Files in a zip | 10 000 |
| Compression ratio of one zip entry over 1 MiB | 200:1 |
| Unpacking a zip | 60 s, then the worker is stopped |
| One description file (`.urdf`, `.xacro`, `.xml`, `.sdf`, `.config`, `.yaml`, `.yml`) | 32 MiB |
| One mesh or other file | 256 MiB |
| An XML file that declares an entity | refused; robot description files never need one |
| Elements a xacro expands to | 2 000 000 |
| xacro macro nesting | 16 deep |
| Include nesting (xacro and MJCF) | 8 deep |
| One `${}` expression, or the value it gives | 10 000 characters |
| The whole import after unzipping | 30 s |

**Triangles:** above 2 000 000 in all, or 500 000 in one mesh, the import still loads, and the report warns that the robot
may draw slowly.

## The import report

After an import, the dialog lists what ROCO changed or could not use, grouped as:

| Group | Meaning |
|---|---|
| Problems | something the file asks for could not be done, so that part is missing |
| Limits | a limit was reached, or a part of the robot shows no data |
| Not supported | a feature ROCO does not read; that part is left out |
| Approximated | a feature shown in a simpler way |
| Substituted | a file or choice ROCO had to guess |

Repeated items are counted once, with up to 10 example places. When an import is refused, the dialog shows the reason and
the report up to that point.

**Download report** saves it as a text file, `roco_import_report_<time>.txt`, with the main file and the xacro arguments
used.

Dropping files on the 3D view opens the import dialog with them, so the report shows there too.

## How the importers are checked

`npm run check:import` runs three sets of checks in Chrome:
- **fixtures** for each feature above;
- **hostile files** for each limit;
- **a corpus of 12 public robots**, two each of arms, humanoids, quadrupeds, wheeled robots, hands and drones, in URDF,
  xacro and MJCF.

The corpus check compares each robot with what the reference tools read: `mujoco` 3.17.0 for MJCF, and Python `xacro` 2.1.1
and the URDF itself for the rest. It compares:
- joint names, types, axes and limits, which must be equal;
- every link's pose with all joints at zero, which must be within 1e-5 m and 1e-5 rad.

The SDF converter is checked by hand, not in CI: `node scripts/check-import-corpus.mjs --sdf DIR` turns the corpus URDFs
into SDF with Gazebo's `gz sdf -p` and compares them the same way.

The corpus files are not in the repository. `tools/corpus/fetch.py` fetches them at the commits pinned in
`tools/corpus/corpus.lock.json`, into `~/.cache/roco-corpus`, and `tools/corpus/reference.py` records the reference beside
them:

```bash
python3 tools/corpus/fetch.py                  # about 300 MB at most; --only NAME for one robot
python3 -m pip install mujoco==3.17.0 xacro==2.1.1
python3 -I tools/corpus/reference.py
npm run check:import
```

Without the fetched corpus, `npm run check:import` skips the corpus part and says so. With only some robots fetched, it
fails and names the missing ones; `node scripts/check-import-corpus.mjs --only NAME` checks just those fetched. CI runs
five of the robots: jvrc1, skydio_x2, upkie, go2 and h1.
