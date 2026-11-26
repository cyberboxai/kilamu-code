import React from 'react';

export interface CustomerCardProps {
  customer_id: number;
  full_name: string;
}

export function CustomerCard({ customer_id, full_name }: CustomerCardProps) {
  return (
    <div className="customer-card" data-customer={customer_id}>
      {full_name}
    </div>
  );
}
