package mq

import "time"

// OrderCreated 订单创建事件，发到 order-events
type OrderCreated struct {
	OrderID int64
	UserID  int64
	Amount  int64
}

// OrderPaid 订单已支付事件，发到 order-events
type OrderPaid struct {
	OrderID int64
}

// PaySucceeded 支付服务发来的支付成功事件（pay-events）
type PaySucceeded struct {
	OrderID int64
	PaidAt  time.Time
}
