package mq

import "context"

type Producer struct {
	client Client
}

func (p *Producer) PublishCreated(ctx context.Context, o OrderCreated) error {
	return p.client.Send(ctx, "order-events", &o)
}

func (p *Producer) PublishPaid(ctx context.Context, orderID int64) error {
	return p.client.Send(ctx, "order-events", &OrderPaid{OrderID: orderID})
}
