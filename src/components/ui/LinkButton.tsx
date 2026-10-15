import { motion } from "motion/react";
import { Link, type LinkProps } from "react-router-dom";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./buttonStyles";

const MotionLink = motion.create(Link);

type SafeLinkProps = Omit<
  LinkProps,
  "onAnimationStart" | "onAnimationEnd" | "onDrag" | "onDragStart" | "onDragEnd"
>;

interface LinkButtonProps extends SafeLinkProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
}

export default function LinkButton({
  variant = "primary",
  size = "md",
  fullWidth,
  className,
  children,
  ...props
}: LinkButtonProps) {
  return (
    <MotionLink
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.96, y: 0 }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
      className={buttonClasses(variant, size, fullWidth, className)}
      {...props}
    >
      {children}
    </MotionLink>
  );
}
