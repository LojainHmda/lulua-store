import { useEffect, useState } from "react";
import { ordersApi } from "../../../firebase/collections";
import type { AdminOrder } from "../../types";

// Shared by OrderDetail and its three dedicated sub-pages (Customer &
// Shipping / Customer History / Internal Information) -- each of those is
// reached directly by its own route (orders/:id/customer etc.), not as a
// child of OrderDetail, so each needs its own copy of this exact fetch
// rather than receiving the order via props.
export function useOrder(id: string | undefined) {
  const [order, setOrder] = useState<AdminOrder | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    ordersApi.get(id).then((o) => {
      setOrder(o ?? null);
      setLoading(false);
    });
  }, [id]);

  return { order, setOrder, loading };
}
