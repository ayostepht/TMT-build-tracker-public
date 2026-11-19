# Site admin: 3D model and print geometry

The kit admin (`/admin/templates`, visible to site admins: the accounts whose verified email is in `ADMIN_EMAILS`, and people another site admin made admin) is where a site admin manages the kit. You do not need any of this to use the standard kit: the MakeGood model and print geometry are installed from the kit pack on first start (see the README and [docs/kit-pack.md](../kit-pack.md)).

## 3D model

The kit admin builds the chair's 3D model from **your own copy** of MakeGood's STEP files, if you want to replace the bundled kit pack (the standard kit needs no upload). The bundled files are in the image (kit pack); imports stay in the `/data` volume.

1. Open **Kit admin**, pick the kit, choose MakeGood's STEP zip (up to 200 MB) and press **Import the model**. A background job converts the files in a separate process (heap capped at 768 MB, one job at a time) and reports per file: converted, missing, failed or skipped (the assembly and the `OBSOLETE/` folder are never converted). It takes about a minute for the whole kit.
2. **Placement**: the viewer lists every part; pick one and nudge it (position in mm, rotation in degrees, mirror, extra copies such as the 4 rim halves or 16 tire segments). **Save** stores the numbers; the model itself is never reconverted.
3. **Hardware model (maintainers only)**: casters, bolts and bearings come from the assembly STEP, which needs about 1.4 GB of memory. The hardware GLB ships inside the kit pack and the app draws generic stand-ins (casters, harness, buckles) when none is present; it is not user-uploadable. To rebuild the pack's hardware GLB, convert it once on a machine with enough RAM:

   ```bash
   npm ci
   node --max-old-space-size=4096 scripts/step-to-glb.mjs "TMT 3D TOP ASSEMBLY.step" hardware.glb
   # see which products are in the assembly / pick them yourself:
   node scripts/step-to-glb.mjs "TMT 3D TOP ASSEMBLY.step" --list
   node scripts/step-to-glb.mjs "TMT 3D TOP ASSEMBLY.step" hardware.glb --include 'caster|bearing' --exclude 'wheel'
   ```

   then put `hardware.glb` into the kit pack (see [docs/kit-pack.md](../kit-pack.md)). There is no upload route.

Uploads are sent as the raw file body (not multipart), so the server streams them to disk instead of holding hundreds of MB in memory. The STEP zip route accepts up to 200 MB on its own, but every request body must also fit `BODY_SIZE_LIMIT` (the image sets `100M`, the most Cloudflare's free plan lets through) and whatever proxy is in front; to import a larger zip, raise both, or use a smaller zip with only the part files. See the [environment reference](environment.md#upload-and-body-limits).

Developing without the zip: `DATABASE_URL=... DATA_DIR=./data node scripts/dev-register-model.mjs <template slug> <model.glb>` copies a GLB you built earlier into the data directory and registers it.

## Importing print geometry without the browser

For the 88 MB MakeGood profile, the command line runs the same import as the kit admin page, inside the container:

```bash
docker cp profile.3mf <container>:/tmp/profile.3mf
docker exec <container> node scripts/import-print-geometry.mjs --list
docker exec <container> node scripts/import-print-geometry.mjs \
  --template makegood-tmt-revb --file /tmp/profile.3mf [--file /tmp/harness.zip]
```

`--file` may be repeated and may be a zip of 3MFs. `--init` migrates and seeds a brand new (scratch) database first.
