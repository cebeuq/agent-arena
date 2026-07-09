export type KeyHint = {
  key: string;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  disabledReason?: string;
};

export function hint(key: string, label: string, extras: Partial<Omit<KeyHint, "key" | "label">> = {}): KeyHint {
  return { key, label, ...extras };
}
