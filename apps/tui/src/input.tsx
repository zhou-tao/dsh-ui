import React, { useEffect, useState } from "react";
import { Text, useInput } from "ink";

interface InputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
}

/** 单行输入框（Ink v7 主包不再内置 TextInput）。支持：可打印字符、Backspace/Delete、左右移动光标、Enter 提交。 */
export function Input({ value, onChange, onSubmit, placeholder, disabled }: InputProps): React.JSX.Element {
  const [cursor, setCursor] = useState(value.length);
  useEffect(() => {
    if (value === "") setCursor(0);
  }, [value]);

  useInput((input, key) => {
    if (disabled) return;
    if (key.return) {
      onSubmit?.();
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor((c) => c - 1);
      }
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(value.length, c + 1));
      return;
    }
    if (input.length === 1) {
      onChange(value.slice(0, cursor) + input + value.slice(cursor));
      setCursor((c) => c + 1);
    }
  });

  if (value.length === 0) {
    return (<Text><Text inverse> </Text><Text dimColor>{placeholder ?? ""}</Text></Text>);
  }
  return (
    <Text>
      {value.slice(0, cursor)}
      <Text inverse>{value[cursor] ?? " "}</Text>
      {value.slice(cursor + 1)}
    </Text>
  );
}
