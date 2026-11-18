package service

import "time"

const (
	StatusPending int8 = 0
	StatusPaid    int8 = 1
	StatusClosed  int8 = 2
)

// Order 订单聚合，由 buildOrder() 组装
type Order struct {
	ID          int64 // snowflake 单号
	UserID      int64
	Items       []*OrderItem
	ItemsAmount int64 // 商品总额（分）
	PayAmount   int64 // 应付金额（分）
	Status      int8
	CreatedAt   time.Time
}

type OrderItem struct {
	SkuID int64
	Qty   int32
	Price int64
}
