# Lunar Rift terrain post-pass: decimate + slope-split PBR textures (Blender headless).
#
#   "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python tools/blender_terrain_pass.py
#
# Pipeline position: runs AFTER tools/generate-lunar-rift.ts emits raw chunks into
# content/props/. It REWRITES lunar-rift-chunk-*.glb (+_lod1) in place with:
#   - Decimate: LOD0 x0.35, LOD1 x0.12 of the raw LOD0 (silhouette-safe, validated on
#     the prototype: 24.5k -> 8.6k tris with no visible silhouette loss).
#   - Two materials split by face slope (normal.z >= 0.55 = regolith floor,
#     else fractured rock wall), PolyHaven CC0 sets from content/props/textures/.
#   - World-aligned tiling UVs (cube project, 14u tile).
#   - Standard glTF Principled graph (baseColor + normal + roughness + AO via the
#     glTF Settings group) so the exporter emits spec-clean PBR.
# Vertex colors (baked AO/strata) survive decimation and multiply the base color per
# the glTF spec; tools/postprocess-terrain-glbs.mjs rescales them afterward (the raw
# values encode absolute albedo, ~0.31 mean, which would double-darken the textures).
#
# Determinism note: re-running the GENERATOR overwrites these files with raw chunks —
# always re-run this pass (and the node post-pass) after regeneration.
import bpy
import os
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
PROPS = os.path.join(ROOT, "content", "props")
# 2K authoring masters live outside the served content tree.
TEX = os.path.join(ROOT, "tools", "lunar-rift", "textures-src")
GAME_TEX = os.path.join(PROPS, "textures", "game")
CHUNKS = 16
DECIMATE_LOD0 = 0.35
DECIMATE_LOD1 = 0.12
SLOPE_Z = 0.55
# Floor regolith is fine-grained: at 14u tiles it mipped to flat gray at gameplay
# distance (verified in-engine). Bigger floor tiles keep readable features; the
# rock walls carry larger detail and stay tighter.
# Aerial scan: features are meter-scale patches; 90u tiles keep them 2-8u in
# world space, readable from flight distance.
TILE_FLOOR = 90.0
TILE_WALL = 18.0

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
for prefix in ("aerial_ground_rock", "gray_rocks"):
    for kind in ("diff", "nor", "rough", "ao"):
        GAME_MAPS[(prefix, kind)] = make_game_texture(
            f"{prefix}_{kind}_2k.jpg", f"{prefix}_{kind}_1k.jpg",
            desaturate=(prefix == "aerial_ground_rock" and kind == "diff"),
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


def process(glb_path, ratio, floor_mat_name, wall_mat_name):
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=glb_path)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    if len(meshes) != 1:
        raise RuntimeError(f"{glb_path}: expected 1 mesh, got {len(meshes)}")
    obj = meshes[0]
    before = len(obj.data.polygons)
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new("DEC", 'DECIMATE')
    mod.ratio = ratio
    bpy.ops.object.modifier_apply(modifier="DEC")
    after = len(obj.data.polygons)

    # Darker tint: the sun (1.45) blows out a ~0.55-mean albedo and erases the
    # texture on lit floors (verified in-engine; shadow sides read fine).
    floor_mat = build_material(floor_mat_name, "aerial_ground_rock", tint=(0.46, 0.47, 0.52), normal_strength=1.2)
    wall_mat = build_material(wall_mat_name, "gray_rocks")
    obj.data.materials.clear()
    obj.data.materials.append(floor_mat)
    obj.data.materials.append(wall_mat)
    # WORLD-space normals: the glTF importer parks the Y-up -> Z-up conversion on
    # the OBJECT transform, so poly.normal (local) has "up" on a horizontal axis.
    # Classifying by local z silently swapped floor/wall per wall azimuth.
    rot = obj.matrix_world.to_3x3()
    for poly in obj.data.polygons:
        n = (rot @ poly.normal).normalized()
        poly.material_index = 0 if n.z >= SLOPE_Z else 1

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
    return before, after


total_before = 0
total_after = 0
for i in range(CHUNKS):
    lod0 = os.path.join(PROPS, f"lunar-rift-chunk-{i}.glb")
    b, a = process(lod0, DECIMATE_LOD0, "RIFT_FLOOR", "RIFT_WALL")
    total_before += b
    total_after += a
    log(f"chunk {i} LOD0 {b} -> {a}")
    lod1 = os.path.join(PROPS, f"lunar-rift-chunk-{i}_lod1.glb")
    # LOD1 raw is ~x0.27 of LOD0 raw; bring it to ~0.12 of raw LOD0 overall
    b1, a1 = process(lod1, max(0.05, DECIMATE_LOD1 / 0.27), "RIFT_FLOOR", "RIFT_WALL")
    log(f"chunk {i} LOD1 {b1} -> {a1}")

log(f"TOTAL LOD0 {total_before} -> {total_after}")
log("done")
sys.exit(0)
