import { NextResponse } from "next/server";
import { z } from "zod";
import { owner, fail, sameOrigin, jsonBody, ApiError } from "@/lib/api";
import { productInputSchema, catalogRpcFailure } from "@/lib/catalog-validation";

export const runtime = "nodejs";
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const { user, merchant, admin } = await owner();
    if (!merchant) throw new ApiError(404, "No hay un comercio configurado.");
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new ApiError(400, "Identificador de producto inválido.");
    const parsed = productInputSchema.safeParse(await jsonBody(request));
    if (!parsed.success) throw new ApiError(400, "Revisa el nombre, precio y código del producto.");
    const { data: existing, error: readError } = await admin.from("products").select("id").eq("id", id).eq("merchant_id", merchant.id).maybeSingle();
    if (readError) throw new ApiError(503, "No se pudo consultar el producto.");
    if (!existing) throw new ApiError(404, "Producto no encontrado.");
    const { data, error } = await admin.rpc("save_product", {
      p_merchant_id: merchant.id, p_actor_user_id: user.id, p_product_id: id,
      p_name: parsed.data.name, p_price_cents: parsed.data.price_cents,
      p_barcode: parsed.data.barcode, p_active: parsed.data.active,
    });
    if (error) { const failure = catalogRpcFailure(error); throw new ApiError(failure.status, failure.message); }
    const product = Array.isArray(data) ? data[0] : data;
    if (!product?.id) throw new ApiError(503, "No se pudo guardar el producto.");
    return NextResponse.json({ product: { id: product.id, name: product.name, price_cents: product.price_cents, barcode: product.barcode, active: product.active } });
  } catch (e) { return fail(e); }
}
