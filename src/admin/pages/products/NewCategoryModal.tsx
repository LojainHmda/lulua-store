import { useEffect, useState } from "react";
import { useLanguage } from "../../../context/LanguageContext";
import { categoriesApi } from "../../../firebase/collections";
import { CATEGORY_ICON_KEYS } from "../../../components/ui/CategoryIcons";
import { useAdminAuth } from "../../AdminAuthContext";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/ToastContext";
import { AdminButton, AdminInput, Field } from "../../components/ui";
import { logActivity } from "../../logActivity";
import { slugify } from "../../slugify";
import type { AdminCategory } from "../../types";

// Quick-add from a product form: creates the category with the same
// defaults CategoryList uses (image/tagline can be filled in there later),
// then hands it back so the form can select it. `beforeCreate` lets the form
// persist its starter categories first (see ProductForm).
export default function NewCategoryModal({
  open,
  onClose,
  categories,
  beforeCreate,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  categories: AdminCategory[];
  beforeCreate: () => Promise<void>;
  onCreated: (category: AdminCategory) => void;
}) {
  const { t } = useLanguage();
  const toast = useToast();
  const { profile } = useAdminAuth();
  const [newCat, setNewCat] = useState({ name: "", nameAr: "", slug: "" });
  const [slugTouched, setSlugTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNewCat({ name: "", nameAr: "", slug: "" });
    setSlugTouched(false);
  }, [open]);

  async function handleCreate() {
    if (!profile) return;
    const name = newCat.name.trim();
    const nameAr = newCat.nameAr.trim();
    const slug = newCat.slug.trim();
    if (!name || !nameAr || !slug) {
      toast.error(t("admin.productForm.newCategoryErrRequired"));
      return;
    }
    if (categories.some((c) => c.slug === slug)) {
      toast.error(t("admin.productForm.newCategoryErrExists"));
      return;
    }
    setSaving(true);
    try {
      const data: Omit<AdminCategory, "id"> = {
        slug,
        name,
        nameAr,
        tagline: "",
        taglineAr: "",
        imageId: "",
        imageUrl: "",
        icon: CATEGORY_ICON_KEYS[0],
        order: categories.length,
      };
      await beforeCreate();
      const newId = await categoriesApi.create(data);
      await logActivity(profile, "category.created", name);
      onCreated({ ...data, id: newId });
      toast.success(t("admin.categories.created"));
      onClose();
    } catch {
      toast.error(t("admin.categories.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("admin.categories.addCategory")} width="sm">
      <div className="flex flex-col gap-4">
        <Field label={t("admin.categories.name")} required>
          <AdminInput
            autoFocus
            value={newCat.name}
            onChange={(e) => {
              const name = e.target.value;
              setNewCat((c) => ({ ...c, name, slug: slugTouched ? c.slug : slugify(name) }));
            }}
          />
        </Field>
        <Field label={t("admin.categories.nameAr")} required>
          <AdminInput dir="rtl" value={newCat.nameAr} onChange={(e) => setNewCat((c) => ({ ...c, nameAr: e.target.value }))} />
        </Field>
        <Field label={t("admin.categories.slug")} required>
          <AdminInput
            value={newCat.slug}
            onChange={(e) => {
              setSlugTouched(true);
              setNewCat((c) => ({ ...c, slug: slugify(e.target.value) }));
            }}
          />
        </Field>
        <div className="mt-2 flex justify-end gap-2">
          <AdminButton variant="ghost" onClick={onClose}>
            {t("admin.common.cancel")}
          </AdminButton>
          <AdminButton variant="primary" loading={saving} onClick={handleCreate}>
            {t("admin.categories.createCategory")}
          </AdminButton>
        </div>
      </div>
    </Modal>
  );
}
