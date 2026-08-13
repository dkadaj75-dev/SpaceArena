# Lunar Rift terrain post-pass: decimate + slope-split PBR textures (Blender headless).
#
#   "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python tools/blender_terrain_pass.py
#
# Pipeline position: runs AFTER tools/generate-lunar-rift.ts emits raw chunks into
# content/props/. It REWRITES lunar-rift-chunk-*.glb (+_lod1) in place with:
#   - Decimate: LOD0 x0.35, LOD1 x0.12 of the raw LOD0 (silhouette-safe, validated on
#     the prototype: 24.5k -> 8.6k tris with no visible silhouette loss).
#   - Two materials split by face slope (a spatially-jittered normal.z threshold
#     around 0.55 = regolith floor, else fractured rock wall).
#   - World-aligned, per-material cube-projected UVs.
#   - A material-boundary-safe limited dissolve on floor regions. Mesh boundary
#     edges are retained so adjacent chunk edge rows remain bit-for-bit aligned.
#   - Standard glTF Principled graph (baseColor + normal + roughness + AO via the
#     glTF Settings group) so the exporter emits spec-clean PBR.
# Vertex colors (baked AO/strata) survive decimation and multiply the base color per
# the glTF spec; tools/postprocess-terrain-glbs.mjs rescales them afterward (the raw
# values encode absolute albedo, ~0.31 mean, which would double-darken the textures).
#
# Determinism note: re-running the GENERATOR overwrites these files with raw chunks —
# always re-run this pass (and the node post-pass) after regeneration.
import bpy
import argparse
import json
import math
import os
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def parse_args():
    parser = argparse.ArgumentParser(description="Texture and decimate Lunar Rift terrain GLBs")
    parser.add_argument(
        "--props-dir",
        default=os.path.join(ROOT, "content", "props"),
        help="Chunk GLB directory (default: content/props)",
    )
    parser.add_argument(
        "--chunks",
        default="all",
        help="Comma-separated chunk indices for iteration (default: all)",
    )
    parser.add_argument("--stats-file", help="Optional JSON path for per-chunk triangle statistics")
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return parser.parse_args(argv)


ARGS = parse_args()
PROPS = os.path.abspath(ARGS.props_dir)
CHUNK_INDICES = range(16) if ARGS.chunks == "all" else [int(v) for v in ARGS.chunks.split(",")]
# 2K authoring masters live outside the served content tree.
TEX = os.path.join(ROOT, "tools", "lunar-rift", "textures-src")
GAME_TEX = os.path.join(PROPS, "textures", "game")
CHUNKS = 16
DECIMATE_LOD0 = 0.35
DECIMATE_LOD1 = 0.12
SLOPE_Z = 0.55
SLOPE_JITTER = 0.12
# The raw height field carries sub-degree high-frequency noise, and the initial
# collapse pass turns that into several-degree micro facets. A 15-degree planar
# limit removes those gameplay-flat facets while the material delimiter keeps
# the actual rim/wall break intact. LOD1 uses the same spatial tolerance.
FLOOR_DISSOLVE_DEG_LOD0 = 15.0
FLOOR_DISSOLVE_DEG_LOD1 = 15.0
# Floor regolith is fine-grained: at 14u tiles it mipped to flat gray at gameplay
# distance (verified in-engine). Bigger floor tiles keep readable features; the
# rock walls carry larger detail and stay tighter.
# Aerial scan: features are meter-scale patches; 90u tiles keep them 2-8u in
# world space, readable from flight distance.
TILE_FLOOR = 90.0
TILE_WALL = 24.0

os.makedirs(GAME_TEX, exist_ok=True)


def log(msg):
    print(f"[terrain-pass] {msg}", flush=True)


def make_game_texture(src_name, out_name, size=1024, desaturate=False):
    """1K game copies of the 2K masters (jpg, quality 88)."""
    out_path = os.path.join(GAME_TEX, out_name)
    if os.path.exists(out_path):
        return out_name
    img = bpy.data.images.load(os.path.join(TEX, src_name), check_existing=False)
    if desaturate:
        # Earth ground scans carry vegetation hues; regolith is achromatic.
        px = list(img.pixels)
        for i in range(0, len(px), 4):
            l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
            px[i] = px[i + 1] = px[i + 2] = l
        img.pixels = px
    img.scale(size, size)
    scene = bpy.context.scene
    scene.render.image_settings.file_format = 'JPEG'
    scene.render.image_settings.quality = 88
    img.save_render(out_path, scene=scene)
    bpy.data.images.remove(img)
    log(f"game texture {out_name}")
    return out_name


GAME_MAPS = {}
for prefix in ("moon_dusted_01", "cliff_side"):
    for kind in ("diff", "nor", "rough", "ao"):
        GAME_MAPS[(prefix, kind)] = make_game_texture(
            f"{prefix}_{kind}_2k.jpg", f"{prefix}_{kind}_1k.jpg",
            # The cliff scan has excellent bedding but a strong terrestrial
            # orange cast. Preserve its value/fracture detail, not its hue.
            desaturate=(prefix == "cliff_side" and kind == "diff"),
        )


def build_material(name, prefix, tint=None, normal_strength=1.0):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Metallic"].default_value = 0.0

    def img_node(kind, noncolor):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = bpy.data.images.load(os.path.join(GAME_TEX, GAME_MAPS[(prefix, kind)]), check_existing=True)
        if noncolor:
            n.image.colorspace_settings.name = 'Non-Color'
        return n

    diff = img_node("diff", False)
    if tint:
        # Exported as baseColorFactor: neutralizes the warm sand tone toward
        # cold lunar gray without touching the texture itself.
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs["B"].default_value = (*tint, 1.0)
        nt.links.new(diff.outputs["Color"], mix.inputs["A"])
        nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    else:
        nt.links.new(diff.outputs["Color"], bsdf.inputs["Base Color"])
    rough = img_node("rough", True)
    nt.links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    nor = img_node("nor", True)
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.inputs["Strength"].default_value = normal_strength
    nt.links.new(nor.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    # AO via the exporter's recognized "glTF Settings" group -> occlusionTexture
    group = bpy.data.node_groups.get("glTF Settings")
    if group is None:
        group = bpy.data.node_groups.new("glTF Settings", "ShaderNodeTree")
        group.interface.new_socket("Occlusion", in_out='INPUT', socket_type='NodeSocketFloat')
    gnode = nt.nodes.new("ShaderNodeGroup")
    gnode.node_tree = group
    ao = img_node("ao", True)
    nt.links.new(ao.outputs["Color"], gnode.inputs["Occlusion"])
    return mat


def clear_scene():
    bpy.ops.wm.read_homefile(use_empty=True)


def face_noise(center):
    """Stable face-center hash in [-1, 1]; no process/global RNG state."""
    # Quantized 3.5u cells make small patches rather than salt-and-pepper faces.
    q = tuple(math.floor(v / 3.5) for v in center)
    h = ((q[0] * 73856093) ^ (q[1] * 19349663) ^ (q[2] * 83492791)) & 0xffffffff
    h ^= h >> 16
    h = (h * 0x7feb352d) & 0xffffffff
    h ^= h >> 15
    h = (h * 0x846ca68b) & 0xffffffff
    h ^= h >> 16
    return (h / 0xffffffff) * 2.0 - 1.0


def triangulated_material_counts(mesh):
    mesh.calc_loop_triangles()
    counts = [0, 0]
    for tri in mesh.loop_triangles:
        material = mesh.polygons[tri.polygon_index].material_index
        if material < 2:
            counts[material] += 1
    return counts


def dissolve_floor(obj, angle_degrees):
    """Planar-reduce floor faces while retaining material and mesh boundaries."""
    before = triangulated_material_counts(obj.data)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.object.mode_set(mode='OBJECT')
    for poly in obj.data.polygons:
        poly.select = poly.material_index == 0
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.dissolve_limited(
        angle_limit=math.radians(angle_degrees),
        use_dissolve_boundaries=False,
        delimit={'MATERIAL'},
    )
    # glTF primitives must be triangles for stable counts/runtime behavior.
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.quads_convert_to_tris(quad_method='BEAUTY', ngon_method='BEAUTY')
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.data.update()
    return before, triangulated_material_counts(obj.data)


def process(glb_path, ratio, dissolve_degrees, floor_mat_name, wall_mat_name):
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=glb_path)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    if len(meshes) != 1:
        raise RuntimeError(f"{glb_path}: expected 1 mesh, got {len(meshes)}")
    obj = meshes[0]
    before = len(obj.data.polygons)
    bpy.context.view_layer.objects.active = obj
    # Collapse only interior vertices. The previous unrestricted modifier could
    # choose a different collapse along each independently processed open chunk
    # edge, producing visible cracks. Skirts are still present, but are no longer
    # needed to conceal topology damage from this pass.
    interior = obj.vertex_groups.new(name="DECIMATE_INTERIOR")
    rot_world = obj.matrix_world
    interior_indices = []
    for vertex in obj.data.vertices:
        world = rot_world @ vertex.co
        if abs(abs(world.x) - 96.0) > 0.01 and abs(abs(world.y) - 96.0) > 0.01:
            interior_indices.append(vertex.index)
    interior.add(interior_indices, 1.0, 'REPLACE')
    mod = obj.modifiers.new("DEC", 'DECIMATE')
    mod.ratio = ratio
    mod.vertex_group = interior.name
    mod.vertex_group_factor = 1.0
    bpy.ops.object.modifier_apply(modifier="DEC")
    # Blender may discard the only deform group while applying the modifier.
    leftover = obj.vertex_groups.get("DECIMATE_INTERIOR")
    if leftover:
        obj.vertex_groups.remove(leftover)
    base_after = len(obj.data.polygons)

    # Darker tint: the sun (1.45) blows out a ~0.55-mean albedo and erases the
    # texture on lit floors (verified in-engine; shadow sides read fine).
    floor_mat = build_material(floor_mat_name, "moon_dusted_01", tint=(0.48, 0.49, 0.53), normal_strength=1.15)
    wall_mat = build_material(wall_mat_name, "cliff_side", tint=(0.56, 0.57, 0.61), normal_strength=1.25)
    obj.data.materials.clear()
    obj.data.materials.append(floor_mat)
    obj.data.materials.append(wall_mat)
    # WORLD-space normals: the glTF importer parks the Y-up -> Z-up conversion on
    # the OBJECT transform, so poly.normal (local) has "up" on a horizontal axis.
    # Classifying by local z silently swapped floor/wall per wall azimuth.
    rot = obj.matrix_world.to_3x3()
    for poly in obj.data.polygons:
        n = (rot @ poly.normal).normalized()
        center = obj.matrix_world @ poly.center
        threshold = SLOPE_Z + SLOPE_JITTER * face_noise(center)
        poly.material_index = 0 if n.z >= threshold else 1

    material_before, material_after = dissolve_floor(obj, dissolve_degrees)

    # per-material tiling: select faces by material slot, cube-project each set
    for slot, tile in ((0, TILE_FLOOR), (1, TILE_WALL)):
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='DESELECT')
        bpy.ops.object.mode_set(mode='OBJECT')
        for poly in obj.data.polygons:
            poly.select = poly.material_index == slot
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.uv.cube_project(cube_size=tile)
        bpy.ops.object.mode_set(mode='OBJECT')

    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format='GLB',
        export_apply=True,
        export_yup=True,
        export_image_format='JPEG',
        export_jpeg_quality=85,
        # The rebuilt Principled graph does not reference the color attribute, and
        # 'MATERIAL' mode would then drop/blank COLOR_0 — but the baked AO/strata
        # (tunnel darkness!) lives there and the glTF spec multiplies it into
        # baseColor at render time. Export the attribute values as-is.
        export_vertex_color='ACTIVE',
    )
    return {
        "raw": before,
        "base": base_after,
        "final": sum(material_after),
        "floor_before": material_before[0],
        "floor_after": material_after[0],
        "wall_before": material_before[1],
        "wall_after": material_after[1],
    }


total_before = 0
total_after = 0
all_stats = []
for i in CHUNK_INDICES:
    lod0 = os.path.join(PROPS, f"lunar-rift-chunk-{i}.glb")
    stats = process(lod0, DECIMATE_LOD0, FLOOR_DISSOLVE_DEG_LOD0, "RIFT_FLOOR", "RIFT_WALL")
    total_before += stats["raw"]
    total_after += stats["final"]
    reduction = 100.0 * (1.0 - stats["floor_after"] / max(1, stats["floor_before"]))
    log(f"chunk {i} LOD0 raw {stats['raw']} base {stats['base']} final {stats['final']} "
        f"floor {stats['floor_before']}->{stats['floor_after']} ({reduction:.1f}% reduction) "
        f"wall {stats['wall_before']}->{stats['wall_after']}")
    lod1 = os.path.join(PROPS, f"lunar-rift-chunk-{i}_lod1.glb")
    # LOD1 raw is ~x0.27 of LOD0 raw; bring it to ~0.12 of raw LOD0 overall
    stats1 = process(lod1, max(0.05, DECIMATE_LOD1 / 0.27), FLOOR_DISSOLVE_DEG_LOD1, "RIFT_FLOOR", "RIFT_WALL")
    reduction1 = 100.0 * (1.0 - stats1["floor_after"] / max(1, stats1["floor_before"]))
    log(f"chunk {i} LOD1 raw {stats1['raw']} base {stats1['base']} final {stats1['final']} "
        f"floor {stats1['floor_before']}->{stats1['floor_after']} ({reduction1:.1f}% reduction) "
        f"wall {stats1['wall_before']}->{stats1['wall_after']}")
    all_stats.append({"chunk": i, "lod0": stats, "lod1": stats1})

log(f"TOTAL LOD0 {total_before} -> {total_after}")
if ARGS.stats_file:
    stats_path = os.path.abspath(ARGS.stats_file)
    os.makedirs(os.path.dirname(stats_path), exist_ok=True)
    with open(stats_path, "w", encoding="utf8") as stats_out:
        json.dump({"chunks": all_stats, "total_lod0_raw": total_before, "total_lod0_final": total_after}, stats_out, indent=2)
    log(f"stats {stats_path}")
log("done")
sys.exit(0)
