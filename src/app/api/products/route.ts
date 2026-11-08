import { NextResponse } from "next/server";
import { access, owner, fail, sameOrigin, jsonBody, ApiError } from "@/lib/api";
import { productInputSchema, catalogRpcFailure } from "@/lib/catalog-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PRODUCT_FIELDS = "id,name,price_cents,barcode,active";

export async function GET(request: Request) {
  try {
    const { merchant, role, admin } = await access();
    if (!merchant) throw new ApiError(404, "No hay un comercio configurado.");
    const includeInactive = new URL(request.url).searchParams.get("include_inactive");
    if (includeInactive !== null && !["true", "false"].includes(includeInactive)) throw new ApiError(400, "Filtro inválido.");
    if (includeInactive === "true" && role !== "admin") throw new ApiError(403, "Solo administradores pueden consultar productos inactivos.");
    let query = admin.from("products").select(PRODUCT_FIELDS).eq("merchant_id", merchant.id);
    if (includeInactive !== "true") query = query.eq("active", true);
    const { data, error } = await query.order("name").order("id").limit(1001);
    if (error) throw new ApiError(503, "No se pudo consultar el catálogo.");
    return NextResponse.json({ products: data.slice(0, 1000), truncated: data.length > 1000 }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return fail(e); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { user, merchant, admin } = await owner();
    if (!merchant) throw new ApiError(404, "No hay un comercio configurado.");
    const parsed = productInputSchema.safeParse(await jsonBody(request));
    if (!parsed.success) throw new ApiError(400, "Revisa el nombre, precio y código del producto.");
    const { data, error } = await admin.rpc("save_product", {
      p_merchant_id: merchant.id, p_actor_user_id: user.id, p_product_id: null,
      p_name: parsed.data.name, p_price_cents: parsed.data.price_cents,
      p_barcode: parsed.data.barcode, p_active: parsed.data.active,
    });
    if (error) { const failure = catalogRpcFailure(error); throw new ApiError(failure.status, failure.message); }
    const product = Array.isArray(data) ? data[0] : data;
    if (!product?.id) throw new ApiError(503, "No se pudo guardar el producto.");
    return NextResponse.json({ product: { id: product.id, name: product.name, price_cents: product.price_cents, barcode: product.barcode, active: product.active } }, { status: 201 });
  } catch (e) { return fail(e); }
}
