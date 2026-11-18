package handler

import "net/http"

// 第三方支付的异步回调

// PayNotifyReq 回调参数
type PayNotifyReq struct {
	OutTradeNo string `json:"out_trade_no"` // 订单号
	TotalFee   int64  `json:"total_fee"`    // 分
	Sign       string `json:"sign"`
}

type PayNotifyResp struct {
	ReturnCode string `xml:"return_code"` // SUCCESS / FAIL
}

func Notify(w http.ResponseWriter, r *http.Request) {}
