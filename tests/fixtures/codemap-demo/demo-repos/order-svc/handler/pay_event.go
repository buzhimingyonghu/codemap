package handler

import (
	"context"

	"shop/order-svc/mq"
)

// OnPaySucceeded 消费 pay-events：标记订单已支付，再发已支付事件
func (h *Handler) OnPaySucceeded(ctx context.Context, evt *mq.PaySucceeded) error {
	changed, err := h.svc.MarkPaid(ctx, evt)
	if err != nil {
		return err // 返回错误，消息会重投
	}
	if changed {
		if err := h.svc.PublishPaid(ctx, evt.OrderID); err != nil {
			return err
		}
	}
	return nil
}
